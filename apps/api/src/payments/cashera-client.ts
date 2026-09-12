import { config } from '../config.js';
import { AppError } from '../errors.js';

/**
 * Cashera HTTP client.
 *
 * All gateway traffic goes through here, so there is one place that knows the base
 * URL, the auth header, the timeout and how to read an error. Scattering `fetch`
 * across routes would mean the retry rule and the credential handling existing in
 * several slightly different versions.
 *
 * The retry policy is shaped by one hazard in particular: a request can reach
 * Cashera, create a transaction, and then have its response lost. A blind retry
 * would create a second transaction and a second payment link for one order. Every
 * create therefore carries the same `external_id`, which Cashera treats as
 * idempotent — so the retry returns the original transaction instead of making a
 * new one.
 */

/** Errors that are worth trying again. Anything else is final. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;

/** One method Cashera offers on a common payment form. */
export interface CasheraAvailableMethod {
  code: string;
  title: string;
}

export interface CasheraTransactionDto {
  uuid: string;
  status: string;
  payment_url?: string | null;
  external_id?: string;
  amount?: number;
  currency?: string;
  /**
   * Null while a common payment form is still waiting for the buyer to choose.
   * Filled in once the checkout session becomes a transaction.
   */
  payment_method?: string | null;
  paid_at?: string | null;
  /** True on a common payment form before a method has been picked. */
  selection_required?: boolean;
  /**
   * What the buyer may choose from, decided by this merchant's settings in
   * Cashera's dashboard. Recorded for diagnostics, never used to build a picker of
   * our own — the whole point of the common form is that the list is theirs.
   */
  available_payment_methods?: CasheraAvailableMethod[];
}

export interface CreateTransactionInput {
  /** Minor units (RUB kopecks), integer. */
  amountMinor: number;
  currency: 'RUB';
  /**
   * A method code such as `crypto`, or `null` for the common payment form.
   *
   * `null` is not the same as absent-with-a-default: Cashera requires the key to be
   * omitted from the JSON entirely, and rejects it being present as `null` or `''`.
   * That distinction is enforced in `createTransaction` below.
   */
  paymentMethod: string | null;
  /** Stable reference to our order. The idempotency key for the whole flow. */
  externalId: string;
  description: string;
  callbackUrl: string;
  successUrl: string;
  failUrl: string;
}

export class CasheraError extends AppError {
  readonly httpStatus: number | null;

  constructor(message: string, httpStatus: number | null, details?: unknown) {
    // Mapped to the shop's own taxonomy so a route does not have to know about
    // gateway status codes. 422 is our mistake, everything else is theirs or the
    // network's. `details` rides on AppError, which already renders it into the
    // error payload — and only ever carries the sanitised view built below.
    super(
      httpStatus === 422 ? 'VALIDATION_ERROR' : 'PAYMENT_PROVIDER_ERROR',
      message,
      details,
    );
    this.name = 'CasheraError';
    this.httpStatus = httpStatus;
  }
}

function ensureEnabled(): void {
  if (!config.cashera.enabled) {
    throw new AppError(
      'CARD_PAYMENTS_DISABLED',
      'Оплата картой сейчас недоступна.',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One authenticated request, with a bounded number of attempts.
 *
 * Only the API key is sent. The shared secret is inbound-only: it authenticates
 * webhooks Cashera sends us, and putting it in an outgoing header would leak it to
 * every proxy on the path for no benefit.
 */
async function request<T>(
  path: string,
  init: { method: 'GET' | 'POST'; body?: unknown },
): Promise<T> {
  ensureEnabled();

  const url = `${config.cashera.baseUrl}${path}`;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.cashera.timeoutMs);

    try {
      const response = await fetch(url, {
        method: init.method,
        headers: {
          'x-api-key': config.cashera.apiKey,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      // Read the body once, defensively: an error page is not always JSON.
      const raw = await response.text().catch(() => '');
      let parsed: unknown = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < MAX_ATTEMPTS) {
        lastError = new CasheraError(
          describeStatus(response.status),
          response.status,
        );
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }

      throw new CasheraError(
        describeStatus(response.status),
        response.status,
        response.status === 422 ? safeDetails(parsed) : undefined,
      );
    } catch (error) {
      if (error instanceof CasheraError) throw error;

      // Transport failure or timeout. Retrying is safe for a create because the
      // request carries `external_id`: Cashera returns the existing transaction
      // rather than opening a second one.
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw new CasheraError(
        `Платёжный шлюз недоступен: ${err.name === 'AbortError' ? 'таймаут' : 'ошибка сети'}.`,
        null,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new CasheraError(
    `Платёжный шлюз недоступен: ${lastError?.message ?? 'неизвестная ошибка'}.`,
    null,
  );
}

/** Buyer-safe wording per status. The gateway's own prose may name internals. */
function describeStatus(status: number): string {
  switch (status) {
    case 401:
      return 'Платёжный шлюз отклонил ключ доступа.';
    case 403:
      return 'Платёжный шлюз отклонил конфигурацию магазина.';
    /**
     * The same `external_id` was reused with a different payload, or a payment was
     * switched between a fixed method and the common form. Cashera's idempotency
     * only returns the original transaction for an *exact* repeat.
     *
     * Worth its own wording: it means this order already has a payment that differs
     * from what we just asked for, which is a real integration fault rather than
     * something a buyer can retry past.
     */
    case 409:
      return 'Для этого заказа уже создан платёж с другими параметрами.';
    case 422:
      return 'Платёжный шлюз отклонил параметры платежа.';
    case 429:
      return 'Слишком много запросов к платёжному шлюзу. Попробуйте ещё раз.';
    case 502:
      return 'Платёжный провайдер вернул ошибку. Попробуйте ещё раз.';
    default:
      return `Ошибка платёжного шлюза (${status}).`;
  }
}

/**
 * Keeps only the field-level part of a validation error.
 *
 * A provider's error body is not ours to forward wholesale — it can carry request
 * echoes and internal identifiers. Only a shallow, string-valued view is kept.
 */
function safeDetails(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== 'object') return undefined;
  const source = parsed as Record<string, unknown>;
  const errors = source.errors ?? source.message ?? source.detail;
  if (typeof errors === 'string') return errors.slice(0, 500);
  if (errors && typeof errors === 'object') {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(errors).slice(0, 20)) {
      flat[key.slice(0, 64)] = String(
        Array.isArray(value) ? value.join(', ') : value,
      ).slice(0, 200);
    }
    return flat;
  }
  return undefined;
}

/**
 * Creates a transaction, or returns the existing one for this `external_id`.
 *
 * Safe to call again after a timeout: Cashera keys idempotency on `external_id`,
 * and this shop derives that from the order, so a retry can only ever refer to the
 * same payment.
 */
export async function createTransaction(
  input: CreateTransactionInput,
): Promise<CasheraTransactionDto> {
  return request<CasheraTransactionDto>('/integration/transactions', {
    method: 'POST',
    body: {
      amount: input.amountMinor,
      currency: input.currency,
      /**
       * Omitted entirely when null, which is what selects the common payment form.
       *
       * Cashera is explicit that the key must be absent — present-but-null or an
       * empty string is rejected. `JSON.stringify` drops `undefined` properties, so
       * spreading conditionally is what actually leaves the key out of the wire
       * format; assigning `undefined` to it would read the same in source but is not
       * the same request.
       */
      ...(input.paymentMethod === null
        ? {}
        : { payment_method: input.paymentMethod }),
      external_id: input.externalId,
      description: input.description,
      callback_url: input.callbackUrl,
      success_url: input.successUrl,
      fail_url: input.failUrl,
    },
  });
}

/** Authoritative status straight from the gateway, for recovery and diagnosis. */
export async function getTransaction(
  uuid: string,
): Promise<CasheraTransactionDto> {
  return request<CasheraTransactionDto>(
    `/integration/transactions/${encodeURIComponent(uuid)}`,
    { method: 'GET' },
  );
}

/**
 * Status by our own reference.
 *
 * The recovery path when a webhook never arrived and the local row may not even
 * carry a uuid yet — our `external_id` is the one identifier that always exists.
 */
export async function getTransactionByExternalId(
  externalId: string,
): Promise<CasheraTransactionDto> {
  return request<CasheraTransactionDto>(
    `/integration/transactions/by-external-id/${encodeURIComponent(externalId)}`,
    { method: 'GET' },
  );
}
