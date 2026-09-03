/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Absolute API origin. Empty means same-origin (via the dev proxy). */
  readonly VITE_API_URL?: string;
  /** Dev-only Telegram id used when running outside Telegram. */
  readonly VITE_DEV_TELEGRAM_ID?: string;
  /** Dev-only proxy target for the Vite server. */
  readonly VITE_API_PROXY_TARGET?: string;
  /** Public link to the club channel, e.g. https://t.me/ochkisk. */
  readonly VITE_CLUB_CHANNEL_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
