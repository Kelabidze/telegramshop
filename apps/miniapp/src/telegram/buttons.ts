import { useEffect, useRef } from 'react';
import { getWebApp } from './webapp.ts';

/**
 * React bindings for Telegram's native bottom and back buttons.
 *
 * Using the native buttons instead of in-page ones is what makes a Mini App
 * feel like part of Telegram rather than a website in a frame.
 */

/**
 * Brand colours for the native MainButton, mirroring `--zone-magenta` and
 * `--zone-on-magenta`. Literals because the Telegram API takes colour strings.
 *
 * The label is dark, not white: white on #E83DFF is 3.2:1, below AA, while the
 * page black on the same fill is 6.1:1. This button is the primary action of
 * every screen that has one, so it is the last place to accept weak contrast.
 */
const MAIN_BUTTON_COLOR = '#e83dff';
const MAIN_BUTTON_TEXT_COLOR = '#08070c';

/**
 * Paints the native button in brand colours.
 *
 * Without this the MainButton follows `themeParams.button_color` — Telegram blue
 * on a default client — which would be the one unmistakably un-branded surface
 * in the app, sitting directly under a magenta interface.
 *
 * Only colours are passed: `setParams` merges, and including `is_visible` or
 * `is_active` here would fight the show/hide/enable calls below.
 */
function applyBrandColors(app: NonNullable<ReturnType<typeof getWebApp>>): void {
  // `setParams` landed in Bot API 6.1, the same floor `theme.ts` uses for
  // `setHeaderColor`. Older clients keep the theme-coloured button.
  if (!app.isVersionAtLeast('6.1')) return;
  try {
    app.MainButton.setParams({
      color: MAIN_BUTTON_COLOR,
      text_color: MAIN_BUTTON_TEXT_COLOR,
    });
  } catch {
    // Purely cosmetic: a client that rejects the call still gets a working
    // button in its own theme colour.
  }
}

export interface MainButtonOptions {
  text: string;
  visible?: boolean;
  enabled?: boolean;
  loading?: boolean;
  onClick: () => void;
}

/**
 * Drives `Telegram.WebApp.MainButton`.
 *
 * The click handler is kept in a ref so changing it between renders does not
 * detach and re-attach the listener (which can drop a tap mid-press).
 */
export function useMainButton(options: MainButtonOptions | null): void {
  const handlerRef = useRef<(() => void) | null>(null);

  // Keep the latest callback without re-subscribing.
  handlerRef.current = options?.onClick ?? null;

  useEffect(() => {
    const app = getWebApp();
    if (!app) return;

    const button = app.MainButton;
    const invoke = () => handlerRef.current?.();
    button.onClick(invoke);

    return () => {
      button.offClick(invoke);
      button.hideProgress();
      button.hide();
    };
  }, []);

  useEffect(() => {
    const app = getWebApp();
    if (!app) return;
    const button = app.MainButton;

    if (!options || options.visible === false) {
      button.hide();
      return;
    }

    // Re-asserted on every show rather than once at mount: `themeChanged` resets
    // the button to the client's palette, and a screen that appears after a theme
    // switch would otherwise come back Telegram blue.
    applyBrandColors(app);

    button.setText(options.text);

    if (options.loading) {
      // `leaveActive: false` blocks double submissions while a request is in
      // flight, which would otherwise create duplicate orders.
      button.showProgress(false);
    } else {
      button.hideProgress();
      if (options.enabled === false) button.disable();
      else button.enable();
    }

    button.show();
  }, [options?.text, options?.visible, options?.enabled, options?.loading]);
}

/**
 * Drives `Telegram.WebApp.BackButton`.
 * Pass `null` to hide it (e.g. on the root screen).
 */
export function useBackButton(onBack: (() => void) | null): void {
  const handlerRef = useRef<(() => void) | null>(null);
  handlerRef.current = onBack;

  useEffect(() => {
    const app = getWebApp();
    if (!app) return;

    const button = app.BackButton;
    const invoke = () => handlerRef.current?.();
    button.onClick(invoke);

    return () => {
      button.offClick(invoke);
      button.hide();
    };
  }, []);

  useEffect(() => {
    const app = getWebApp();
    if (!app) return;
    if (onBack) app.BackButton.show();
    else app.BackButton.hide();
  }, [Boolean(onBack)]);
}
