import { getWebApp, type TelegramThemeParams } from './webapp.ts';

/**
 * Telegram theme bridge, and the brand's claim on the native chrome.
 *
 * Two jobs, deliberately kept separate:
 *
 *   1. Mirror `themeParams` into `--tg-*` CSS variables. Nothing in the brand
 *      layer reads them any more, but the bridge stays: it costs one loop, it is
 *      what a plain browser sees, and removing it would make any future
 *      theme-following element silently fall back to a light default.
 *
 *   2. Paint the parts of the Telegram client the document cannot reach — the
 *      header strip, the canvas behind the WebView — in the brand background.
 *
 * The second job is what makes a fixed dark palette viable. OCHKISK ZONE is dark
 * regardless of the user's client theme, so a client sitting on the light theme
 * would otherwise put `#f4f4f5` chrome directly against a `#08070C` document:
 * a bright seam across the top of the app, and a flash of the wrong colour on
 * every overscroll.
 */

/** The brand background. Duplicated from `--zone-bg` because the Telegram API
 *  takes a colour string, not a CSS variable. */
const ZONE_BG = '#08070c';

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

  /*
   * Always dark, never `app.colorScheme`.
   *
   * This drives how the *browser* renders things the stylesheet does not own:
   * `<select>` popups in the admin forms, form autofill, scrollbars, spell-check
   * underlines. Following a light client here would drop white system widgets
   * into a black interface — and `data-theme` is exported alongside so a future
   * rule can branch on it without reading the client again.
   */
  root.dataset.theme = 'dark';
  root.style.colorScheme = 'dark';

  // Match the native header/background to avoid a visible seam while scrolling.
  if (app?.isVersionAtLeast('6.1')) {
    try {
      app.setHeaderColor(ZONE_BG);
      app.setBackgroundColor(ZONE_BG);
    } catch {
      // Unsupported on older clients; purely cosmetic.
    }
  }
}

/**
 * Re-applies the theme whenever the user switches it inside Telegram.
 *
 * Still worth listening for, even though the palette is fixed: the event is also
 * when the client re-asserts its own header and background colours, so the brand
 * values have to be written again on top.
 */
export function watchTelegramTheme(): () => void {
  const app = getWebApp();
  if (!app) return () => {};

  const handler = () => applyTelegramTheme();
  app.onEvent('themeChanged', handler);
  return () => app.offEvent('themeChanged', handler);
}
