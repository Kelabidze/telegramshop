/**
 * Minimal, typed surface of the Telegram WebApp API.
 *
 * Only the parts this app uses are declared. Everything is optional-safe: the
 * app must keep working in a normal browser (for local development), where
 * `window.Telegram` does not exist.
 *
 * Reference: https://core.telegram.org/bots/webapps
 */

export interface TelegramThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  section_bg_color?: string;
  section_header_text_color?: string;
  subtitle_text_color?: string;
  destructive_text_color?: string;
}

export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending';

export interface TelegramBottomButton {
  text: string;
  isVisible: boolean;
  isActive: boolean;
  setText(text: string): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
  setParams(params: {
    text?: string;
    color?: string;
    text_color?: string;
    is_active?: boolean;
    is_visible?: boolean;
  }): void;
}

export interface TelegramBackButton {
  isVisible: boolean;
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

export interface TelegramHapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      is_premium?: boolean;
    };
    start_param?: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: TelegramThemeParams;
  isExpanded: boolean;
  viewportStableHeight: number;

  MainButton: TelegramBottomButton;
  BackButton: TelegramBackButton;
  HapticFeedback: TelegramHapticFeedback;

  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(version: string): boolean;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  enableClosingConfirmation(): void;
  disableVerticalSwipes?(): void;
  openInvoice(url: string, callback?: (status: InvoiceStatus) => void): void;
  openTelegramLink(url: string): void;
  showAlert(message: string, callback?: () => void): void;
  showConfirm(message: string, callback?: (ok: boolean) => void): void;
  onEvent(event: string, cb: (...args: unknown[]) => void): void;
  offEvent(event: string, cb: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** The WebApp object, or null when running outside Telegram. */
export function getWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

/** True when running inside a real Telegram client. */
export function isTelegramEnvironment(): boolean {
  const app = getWebApp();
  // `initData` is empty when the page is merely opened in a browser.
  return Boolean(app && app.initData.length > 0);
}

/**
 * Raw `initData` used to authenticate against the API.
 * Empty string outside Telegram; the API then falls back to dev auth.
 */
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

/** Signals readiness and expands to full height. Safe to call once at boot. */
export function initializeWebApp(): void {
  const app = getWebApp();
  if (!app) return;

  app.ready();
  app.expand();

  // Prevent an accidental swipe-down from closing the app mid-checkout.
  if (app.isVersionAtLeast('7.7')) {
    app.disableVerticalSwipes?.();
  }
}

export function haptic(
  type: 'success' | 'error' | 'warning' | 'selection' | 'tap',
): void {
  const hf = getWebApp()?.HapticFeedback;
  if (!hf) return;
  try {
    if (type === 'selection') hf.selectionChanged();
    else if (type === 'tap') hf.impactOccurred('light');
    else hf.notificationOccurred(type);
  } catch {
    // Older clients throw on unsupported methods; haptics are non-essential.
  }
}

/** Native alert in Telegram, `window.alert` in a browser. */
export function showAlert(message: string): void {
  const app = getWebApp();
  if (app?.isVersionAtLeast('6.2')) app.showAlert(message);
  else window.alert(message);
}

/** Promise-based confirm dialog. */
export function showConfirm(message: string): Promise<boolean> {
  const app = getWebApp();
  if (app?.isVersionAtLeast('6.2')) {
    return new Promise((resolve) => app.showConfirm(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/**
 * Opens a Telegram invoice and resolves with its final status.
 * Rejects when invoices are unsupported by the client.
 */
export function openInvoice(url: string): Promise<InvoiceStatus> {
  const app = getWebApp();
  if (!app) {
    return Promise.reject(
      new Error('Оплата доступна только внутри Telegram.'),
    );
  }
  if (!app.isVersionAtLeast('6.1')) {
    return Promise.reject(
      new Error('Обновите Telegram, чтобы оплачивать заказы.'),
    );
  }
  return new Promise((resolve) => {
    app.openInvoice(url, resolve);
  });
}

/**
 * The club channel a membership is checked against.
 *
 * Configured, not hardcoded: the same bundle serves staging and production, and
 * the id the API verifies against lives in its own env. An empty value means
 * "not configured", and every entry point that would link there hides itself
 * rather than opening a dead link.
 */
const CLUB_CHANNEL_URL = import.meta.env.VITE_CLUB_CHANNEL_URL ?? '';

export const openChannel = {
  isAvailable(): boolean {
    return CLUB_CHANNEL_URL.length > 0;
  },
  /** The link itself, for rendering as text. Empty means not configured. */
  url(): string {
    return CLUB_CHANNEL_URL;
  },
  /**
   * `openTelegramLink` keeps the user inside Telegram; `window.open` is the
   * browser fallback so the link still works outside the Mini App.
   */
  open(): void {
    if (!CLUB_CHANNEL_URL) return;
    const app = getWebApp();
    if (app?.isVersionAtLeast('6.1')) {
      app.openTelegramLink(CLUB_CHANNEL_URL);
      return;
    }
    window.open(CLUB_CHANNEL_URL, '_blank', 'noopener,noreferrer');
  },
};
