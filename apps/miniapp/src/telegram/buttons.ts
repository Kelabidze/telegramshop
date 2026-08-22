import { useEffect, useRef } from 'react';
import { getWebApp } from './webapp.ts';

/**
 * React bindings for Telegram's native bottom and back buttons.
 *
 * Using the native buttons instead of in-page ones is what makes a Mini App
 * feel like part of Telegram rather than a website in a frame.
 */

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
