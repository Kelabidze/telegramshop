import type {
  ApiErrorCode,
  Banner,
  Category,
  CategoryInput,
  CategoryUpdate,
  CheckoutSession,
  CreateOrderInput,
  Manager,
  ManagerInput,
  Order,
  Product,
  ProductInput,
  ProductListItem,
  ProductUpdate,
  ShopUser,
  StaffOrder,
  Viewer,
} from '@shop/shared';
import { CLUB_RECHECK_PARAM } from '@shop/shared';
import { getInitData } from '../telegram/webapp.ts';

/**
 * Typed API client.
 *
 * Every request carries the raw Telegram `initData` in the Authorization
 * header. The server re-verifies its signature, so the client never asserts
 * who the user is.
 */

/** Same-origin by default: the Vite dev server proxies /api to the backend. */
const BASE_URL = import.meta.env.VITE_API_URL ?? '';

/**
 * Dev-only identity used when the app runs outside Telegram.
 *
 * Gated on `import.meta.env.DEV` so the value and the code path that sends it
 * are dropped from production bundles entirely by dead-code elimination. Vite
 * inlines env vars at build time, so without this guard a stray
 * VITE_DEV_TELEGRAM_ID in a build environment would ship to real users.
 */
const DEV_TELEGRAM_ID = import.meta.env.DEV
  ? (import.meta.env.VITE_DEV_TELEGRAM_ID ?? '')
  : '';

export class ApiError extends Error {
  readonly code: ApiErrorCode | 'NETWORK_ERROR';
  readonly status: number;
  readonly details: unknown;

  constructor(
    code: ApiErrorCode | 'NETWORK_ERROR',
    message: string,
    status: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/**
 * True when the app was opened from the bot's "Я подписался!" button.
 *
 * Read once at load, from the URL the bot built. Telling the server about it
 * makes it re-ask Telegram instead of serving a cached "not a member" — the
 * whole point of that button. Read once rather than per request so a page left
 * open does not keep forcing lookups.
 */
const WANTS_MEMBERSHIP_RECHECK = new URLSearchParams(
  window.location.search,
).has(CLUB_RECHECK_PARAM);

function buildHeaders(hasBody: boolean): HeadersInit {
  const headers: Record<string, string> = {};
  if (hasBody) headers['content-type'] = 'application/json';

  const initData = getInitData();
  if (initData) {
    headers.authorization = `tma ${initData}`;
  } else if (DEV_TELEGRAM_ID) {
    // Only works when the API has ALLOW_DEV_AUTH enabled.
    headers['x-dev-telegram-id'] = DEV_TELEGRAM_ID;
  }

  if (WANTS_MEMBERSHIP_RECHECK) headers['x-club-recheck'] = '1';

  return headers;
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const hasBody = init.body !== undefined;

  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? 'GET',
      headers: buildHeaders(hasBody),
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
  } catch (cause) {
    throw new ApiError(
      'NETWORK_ERROR',
      'Нет связи с сервером. Проверьте соединение.',
      0,
      cause,
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      // Non-JSON response (e.g. a proxy error page).
      if (!response.ok) {
        throw new ApiError(
          'INTERNAL_ERROR',
          `Сервер вернул ошибку ${response.status}.`,
          response.status,
        );
      }
    }
  }

  if (!response.ok) {
    const body = payload as
      | { error?: { code?: ApiErrorCode; message?: string; details?: unknown } }
      | null;
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL_ERROR',
      body?.error?.message ?? `Ошибка ${response.status}.`,
      response.status,
      body?.error?.details,
    );
  }

  return payload as T;
}

export const api = {
  getViewer: () => request<{ viewer: Viewer }>('/api/me').then((r) => r.viewer),

  /** Renames the caller inside the shop. `null` restores the Telegram name. */
  updateDisplayName: (displayName: string | null) =>
    request<{ viewer: Viewer }>('/api/me', {
      method: 'PATCH',
      body: { displayName },
    }).then((r) => r.viewer),

  listCategories: () =>
    request<{ categories: Category[] }>('/api/categories').then(
      (r) => r.categories,
    ),

  listBanners: () =>
    request<{ banners: Banner[] }>('/api/banners').then((r) => r.banners),

  listProducts: (params: { category?: string; search?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.category) query.set('category', params.category);
    if (params.search) query.set('q', params.search);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request<{ products: ProductListItem[] }>(
      `/api/products${suffix}`,
    ).then((r) => r.products);
  },

  getProduct: (slug: string) =>
    request<{ product: Product }>(
      `/api/products/${encodeURIComponent(slug)}`,
    ).then((r) => r.product),

  listOrders: () =>
    request<{ orders: Order[] }>('/api/orders').then((r) => r.orders),

  getOrder: (id: string) =>
    request<{ order: Order }>(`/api/orders/${encodeURIComponent(id)}`).then(
      (r) => r.order,
    ),

  createOrder: (input: CreateOrderInput) =>
    request<CheckoutSession>('/api/orders', { method: 'POST', body: input }),

  cancelOrder: (id: string) =>
    request<{ order: Order }>(
      `/api/orders/${encodeURIComponent(id)}/cancel`,
      { method: 'POST' },
    ).then((r) => r.order),

  // ---- staff ---------------------------------------------------------------

  /** Public, but only the admin finance screen has a reason to read it. */
  getHealth: () =>
    request<{
      ok: boolean;
      env: string;
      payments: string;
      botConfigured: boolean;
      clubChannelConfigured: boolean;
      devAuth: boolean;
    }>('/health'),

  listAllOrders: () =>
    request<{ orders: StaffOrder[]; count: number }>('/api/orders/all').then(
      (r) => r.orders,
    ),

  listAllProducts: () =>
    request<{ products: Product[] }>('/api/products/all').then((r) => r.products),

  createCategory: (input: CategoryInput) =>
    request<{ category: Category }>('/api/categories', {
      method: 'POST',
      body: input,
    }).then((r) => r.category),

  updateCategory: (id: string, input: CategoryUpdate) =>
    request<{ category: Category }>(
      `/api/categories/${encodeURIComponent(id)}`,
      { method: 'PUT', body: input },
    ).then((r) => r.category),

  deleteCategory: (id: string) =>
    request<{ category: Category }>(
      `/api/categories/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ).then((r) => r.category),

  createProduct: (input: ProductInput) =>
    request<{ id: string; keysAdded: number }>('/api/products', {
      method: 'POST',
      body: input,
    }),

  updateProduct: (id: string, input: ProductUpdate) =>
    request<{ id: string; keysAdded: number }>(
      `/api/products/${encodeURIComponent(id)}`,
      { method: 'PUT', body: input },
    ),

  deactivateProduct: (id: string) =>
    request<{ id: string; isActive: boolean }>(
      `/api/products/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    ),

  listShopUsers: (params: { q?: string; role?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.role) query.set('role', params.role);
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request<{ users: ShopUser[]; count: number }>(
      `/api/users${suffix}`,
    ).then((r) => r.users);
  },

  listManagers: () =>
    request<{ managers: Manager[] }>('/api/managers').then((r) => r.managers),

  upsertManager: (input: ManagerInput) =>
    request<{ manager: Manager }>('/api/managers', {
      method: 'POST',
      body: input,
    }).then((r) => r.manager),

  revokeManager: (telegramId: string) =>
    request<{ telegramId: string; role: 'USER' }>(
      `/api/managers/${encodeURIComponent(telegramId)}`,
      { method: 'DELETE' },
    ),
};
