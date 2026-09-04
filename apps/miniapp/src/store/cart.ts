import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  cartTotals,
  type CartTotals,
  type Currency,
  type ProductListItem,
} from '@shop/shared';

/**
 * Cart state.
 *
 * `unitAmountMinor` is the **club tier** price, exactly as stored in the
 * catalog — the same number for every viewer. What the viewer actually pays is
 * derived at render time from their membership (`selectTotals`), so the cart
 * does not go stale when the club status changes.
 *
 * All of it is display-only. The server recomputes every total from the
 * database at checkout, so a stale or tampered cart can never change what the
 * user is charged.
 */

export interface CartLine {
  productId: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  /** Club tier price from the catalog. Display-only; the server re-reads it. */
  unitAmountMinor: number;
  currency: Currency;
  quantity: number;
  /** null = unlimited. Used to clamp quantity in the UI. */
  stock: number | null;
}

interface CartState {
  lines: CartLine[];
  add(product: ProductListItem, quantity?: number): void;
  remove(productId: string): void;
  setQuantity(productId: string, quantity: number): void;
  clear(): void;
}

/** Clamps a quantity to the allowed range and available stock. */
function clampQuantity(quantity: number, stock: number | null): number {
  const upperBound =
    stock === null ? MAX_LINE_QUANTITY : Math.min(stock, MAX_LINE_QUANTITY);
  return Math.max(0, Math.min(Math.trunc(quantity), upperBound));
}

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      lines: [],

      add(product, quantity = 1) {
        set((state) => {
          const existing = state.lines.find(
            (line) => line.productId === product.id,
          );

          if (existing) {
            const next = clampQuantity(
              existing.quantity + quantity,
              product.stock,
            );
            if (next === 0) {
              return {
                lines: state.lines.filter(
                  (line) => line.productId !== product.id,
                ),
              };
            }
            return {
              lines: state.lines.map((line) =>
                line.productId === product.id
                  ? { ...line, quantity: next, stock: product.stock }
                  : line,
              ),
            };
          }

          if (state.lines.length >= MAX_CART_LINES) return state;

          const initial = clampQuantity(quantity, product.stock);
          if (initial === 0) return state;

          return {
            lines: [
              ...state.lines,
              {
                productId: product.id,
                slug: product.slug,
                title: product.title,
                imageUrl: product.imageUrl,
                unitAmountMinor: product.amountMinor,
                currency: product.currency,
                quantity: initial,
                stock: product.stock,
              },
            ],
          };
        });
      },

      remove(productId) {
        set((state) => ({
          lines: state.lines.filter((line) => line.productId !== productId),
        }));
      },

      setQuantity(productId, quantity) {
        set((state) => {
          const line = state.lines.find((l) => l.productId === productId);
          if (!line) return state;
          const next = clampQuantity(quantity, line.stock);
          if (next === 0) {
            return {
              lines: state.lines.filter((l) => l.productId !== productId),
            };
          }
          return {
            lines: state.lines.map((l) =>
              l.productId === productId ? { ...l, quantity: next } : l,
            ),
          };
        });
      },

      clear() {
        set({ lines: [] });
      },
    }),
    {
      name: 'shop-cart-v1',
      // Persist only the lines; actions are recreated on load.
      partialize: (state) => ({ lines: state.lines }),
    },
  ),
);

/** Total item count, for the cart badge. */
export function selectItemCount(state: CartState): number {
  return state.lines.reduce((sum, line) => sum + line.quantity, 0);
}

/**
 * Cart totals at the price this viewer pays.
 *
 * Membership is passed in rather than stored: `unitAmountMinor` in the cart is
 * the club tier straight from the catalog, and the club status can change while
 * items sit in localStorage. Deriving the payable amount on render means
 * subscribing to the channel updates the total on the next paint, and the same
 * shared function runs on the server at checkout — so the invoice matches.
 *
 * Takes `lines` instead of being a Zustand selector. `useCart(selectTotals(x))`
 * looked tidier but froze the whole app: the selector built a fresh object on
 * every call, Zustand compares selector output by reference, so it concluded the
 * store had changed, re-rendered, built another object — an infinite loop that
 * React ends by unmounting the tree, leaving a black screen. Anything deriving
 * an object from the store must either memoise or, as here, be a plain function
 * of already-subscribed state.
 */
export function cartTotalsFor(
  lines: readonly CartLine[],
  isSubscribedChannel: boolean,
): CartTotals {
  return cartTotals(lines, isSubscribedChannel);
}

/** The cart currency, or null when empty. */
export function selectCurrency(state: CartState): Currency | null {
  return state.lines[0]?.currency ?? null;
}
