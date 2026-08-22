import type { Currency } from '@shop/shared';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { requireBot } from '../telegram/bot.js';

/**
 * Payment abstraction.
 *
 * Today only Telegram is used, in two flavours:
 *  - Stars (XTR): `providerToken` must be empty, amounts are whole stars.
 *  - Provider (RUB/USD/...): requires a provider token from BotFather and
 *    amounts in minor units.
 *
 * Keeping this behind an interface means adding a provider later does not touch
 * order logic.
 */

export interface InvoiceLine {
  label: string;
  amountMinor: number;
}

export interface CreateInvoiceInput {
  title: string;
  description: string;
  /** Echoed back by Telegram on success; used to find the order. */
  payload: string;
  currency: Currency;
  lines: InvoiceLine[];
}

export interface PaymentGateway {
  readonly kind: 'stars' | 'provider' | 'none';
  readonly enabled: boolean;
  /** Returns a t.me invoice link to open with `WebApp.openInvoice`. */
  createInvoiceLink(input: CreateInvoiceInput): Promise<string>;
}

/** Telegram caps invoice text; exceeding it makes the API call fail. */
const TITLE_MAX = 32;
const DESCRIPTION_MAX = 255;

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

class TelegramGateway implements PaymentGateway {
  readonly kind: 'stars' | 'provider';
  readonly enabled = true;
  private readonly providerToken: string;

  constructor(kind: 'stars' | 'provider', providerToken: string) {
    this.kind = kind;
    this.providerToken = providerToken;
  }

  async createInvoiceLink(input: CreateInvoiceInput): Promise<string> {
    if (this.kind === 'stars' && input.currency !== 'XTR') {
      throw new AppError(
        'CURRENCY_MISMATCH',
        `Stars payments require the XTR currency, got ${input.currency}.`,
      );
    }
    if (this.kind === 'provider' && input.currency === 'XTR') {
      throw new AppError(
        'CURRENCY_MISMATCH',
        'XTR can only be charged through Stars, not a payment provider.',
      );
    }

    const bot = requireBot();

    return bot.api.createInvoiceLink(
      truncate(input.title, TITLE_MAX),
      truncate(input.description, DESCRIPTION_MAX),
      input.payload,
      // Stars require an empty provider token.
      this.kind === 'stars' ? '' : this.providerToken,
      input.currency,
      input.lines.map((line) => ({
        label: truncate(line.label, TITLE_MAX),
        amount: line.amountMinor,
      })),
    );
  }
}

class DisabledGateway implements PaymentGateway {
  readonly kind = 'none' as const;
  readonly enabled = false;

  async createInvoiceLink(): Promise<string> {
    throw new AppError(
      'PAYMENTS_DISABLED',
      'Payments are disabled (PAYMENT_PROVIDER="none"). Orders are created but cannot be charged.',
    );
  }
}

function build(): PaymentGateway {
  if (!config.telegram.hasBotToken) return new DisabledGateway();
  switch (config.paymentProvider) {
    case 'stars':
      return new TelegramGateway('stars', '');
    case 'provider':
      return new TelegramGateway('provider', config.telegram.providerToken);
    default:
      return new DisabledGateway();
  }
}

export const payments: PaymentGateway = build();
