import { getWebApp, type TelegramThemeParams } from './webapp.ts';

/**
 * Bridges Telegram theme parameters into CSS custom properties so the whole UI
 * follows the user's client theme (light/dark, custom themes) automatically.
 *
 * Fallbacks match Telegram's default light theme, so the app is still usable
 * when opened in a plain browser.
 */

const FALLBACK: Required<
  Pick<
    TelegramThemeParams,
    | 'bg_color'
    | 'text_color'
    | 'hint_color'
    | 'link_color'
    | 'button_color'
    | 'button_text_color'
    | 'secondary_bg_color'
    | 'section_bg_color'
    | 'destructive_text_color'
  >
> = {
  bg_color: '#ffffff',
  text_color: '#000000',
  hint_color: '#707579',
  link_color: '#3390ec',
  button_color: '#3390ec',
  button_text_color: '#ffffff',
  secondary_bg_color: '#f4f4f5',
  section_bg_color: '#ffffff',
  destructive_text_color: '#df3f40',
};

/** Maps `themeParams` keys to CSS variables: bg_color -> --tg-bg-color. */
function cssVarName(key: string): string {
  return `--tg-${key.replace(/_/g, '-')}`;
}

export function applyTelegramTheme(): void {
  const app = getWebApp();
  const root = document.documentElement;

  const params: TelegramThemeParams = { ...FALLBACK, ...(app?.themeParams ?? {}) };

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string') {
      root.style.setProperty(cssVarName(key), value);
    }
  }

  const scheme = app?.colorScheme ?? 'light';
  root.dataset.theme = scheme;
  root.style.colorScheme = scheme;

  // Match the native header/background to avoid a visible seam while scrolling.
  if (app?.isVersionAtLeast('6.1')) {
    try {
      app.setHeaderColor(params.secondary_bg_color ?? FALLBACK.secondary_bg_color);
      app.setBackgroundColor(params.bg_color ?? FALLBACK.bg_color);
    } catch {
      // Unsupported on older clients; purely cosmetic.
    }
  }
}

/** Re-applies the theme whenever the user switches it inside Telegram. */
export function watchTelegramTheme(): () => void {
  const app = getWebApp();
  if (!app) return () => {};

  const handler = () => applyTelegramTheme();
  app.onEvent('themeChanged', handler);
  return () => app.offEvent('themeChanged', handler);
}
