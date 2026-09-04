import { useCallback, useEffect, useRef } from 'react';

/**
 * Remembers and restores the window scroll position per screen.
 *
 * Needed because navigation unmounts the screen: coming back from a product
 * re-creates the catalog at scrollTop 0, which on a long grid throws the user
 * back to the first row. Telegram's WebView has no scroll restoration of its
 * own, and `history.scrollRestoration` does not apply — this app never pushes
 * real history entries.
 *
 * The position is stored in a module-level map rather than in React state so it
 * survives the unmount that makes it necessary in the first place.
 */
const positions = new Map<string, number>();

/** Forget one screen's position, e.g. when its filter changed. */
export function forgetScrollPosition(key: string): void {
  positions.delete(key);
}

export function useScrollRestoration(key: string, isReady = true): void {
  // The latest key in a ref: the cleanup that saves the position runs after the
  // key has already changed, and would otherwise file it under the new screen.
  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    if (!isReady) return;

    const saved = positions.get(key) ?? 0;
    if (saved > 0) {
      // Two frames: the first lets React paint the list, the second runs after
      // the browser has applied its layout, when the document is finally tall
      // enough to scroll to the saved offset. A single frame lands short on
      // long grids.
      const outer = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.scrollTo({ top: saved, behavior: 'instant' });
        });
      });
      return () => cancelAnimationFrame(outer);
    }
    return undefined;
  }, [key, isReady]);

  useEffect(() => {
    const remember = () => {
      positions.set(keyRef.current, window.scrollY);
    };

    // Sampled on scroll instead of only on unmount: Telegram can tear the
    // WebView down without running React cleanup, and a passive listener is
    // cheap enough to keep the value always fresh.
    window.addEventListener('scroll', remember, { passive: true });
    return () => {
      remember();
      window.removeEventListener('scroll', remember);
    };
  }, []);
}

/** Scrolls to the top and clears the stored offset for `key`. */
export function useScrollToTop(key: string): () => void {
  return useCallback(() => {
    forgetScrollPosition(key);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [key]);
}
