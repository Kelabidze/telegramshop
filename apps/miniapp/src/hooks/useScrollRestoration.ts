import { useEffect, useRef } from 'react';

/**
 * Remembers and restores the window scroll position per screen.
 *
 * Needed because navigation unmounts the screen: coming back from a product
 * re-creates the catalog at scrollTop 0, which on a long grid throws the user
 * back to the first row. Telegram's WebView has no scroll restoration of its
 * own, and `history.scrollRestoration` does not apply — this app never pushes
 * real history entries.
 *
 * The position lives in a module-level map rather than in React state so it
 * survives the unmount that makes it necessary in the first place.
 */
const positions = new Map<string, number>();

/** Forget one screen's position, e.g. when its filter changed. */
export function forgetScrollPosition(key: string): void {
  positions.delete(key);
}

/**
 * How long to keep trying to reach the saved offset.
 *
 * A returning screen is short for a few frames — the product grid only gets its
 * full height once React has painted and the browser has done layout. Giving up
 * after one or two frames is exactly what made the first version fail.
 */
const RESTORE_TIMEOUT_MS = 1_000;

/** Landing this close to the target counts as restored. */
const TOLERANCE_PX = 2;

export function useScrollRestoration(key: string, isReady = true): void {
  // The latest key in a ref: the cleanup that saves the position runs after the
  // key has already changed, and would otherwise file it under the new screen.
  const keyRef = useRef(key);
  keyRef.current = key;

  /**
   * True while a restore is in flight.
   *
   * This is the fix for the bug that made restoration look like it did nothing.
   * Scrolling the window fires `scroll`, and the listener below writes whatever
   * it sees into the map. During a restore the document is still short, so the
   * browser clamps the scroll — often to 0 — and that clamped value overwrote
   * the saved offset. The target was destroyed by the very attempt to reach it,
   * so every retry then "restored" to the top.
   */
  const restoringRef = useRef(false);

  // Declared BEFORE the save effect on purpose: React runs cleanups in
  // declaration order, and the save cleanup must see the final value of
  // `restoringRef` set here.
  useEffect(() => {
    if (!isReady) return undefined;

    const target = positions.get(key) ?? 0;
    if (target <= 0) {
      restoringRef.current = false;
      return undefined;
    }

    restoringRef.current = true;
    const deadline = Date.now() + RESTORE_TIMEOUT_MS;
    let frame = 0;

    const attempt = () => {
      const maxScroll =
        document.documentElement.scrollHeight - window.innerHeight;

      // Only scroll once the document can actually hold the offset; scrolling a
      // short document just clamps and wastes the attempt.
      if (maxScroll >= target) {
        // Two-argument form, not `{ behavior: 'instant' }`: `instant` is a
        // newer ScrollBehavior value and older Telegram WebViews ignore the
        // whole options object when they do not recognise it — which means no
        // scroll at all, silently.
        window.scrollTo(0, target);

        if (Math.abs(window.scrollY - target) <= TOLERANCE_PX) {
          restoringRef.current = false;
          return;
        }
      }

      if (Date.now() >= deadline) {
        // Give up rather than spin forever: the list may legitimately have got
        // shorter (a product sold out), and the user is better served by a
        // stable position than by a hunt for an offset that no longer exists.
        restoringRef.current = false;
        return;
      }

      frame = requestAnimationFrame(attempt);
    };

    frame = requestAnimationFrame(attempt);

    return () => {
      cancelAnimationFrame(frame);
      // `restoringRef` is deliberately left true when a restore is cut short by
      // unmount: the stored value is still the offset the user should return to,
      // and the save cleanup below must not replace it with a half-restored one.
    };
  }, [key, isReady]);

  useEffect(() => {
    const remember = () => {
      if (restoringRef.current) return;
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
