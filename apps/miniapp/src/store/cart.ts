import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  MAX_CART_LINES,
  MAX_LINE_QUANTITY,
  type Currency,
  type ProductListItem,
} from '@shop/shared';

/**
 * Cart state.
 *
 * The cart stores a price snapshot only for display. The server recomputes
 * every total from the database at checkout, so a stale or tampered cart can
 * never change what the user is charged.
 */

export interface CartLine {
  productId: string;
  slug: string;
  title: string;
  imageUrl: string | null;
  /** Display-only snapshot. */
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

/** Display total. Authoritative totals come from the server. */
export function selectTotalMinor(state: CartState): number {
  return state.lines.reduce(
    (sum, line) => sum + line.unitAmountMinor * line.quantity,
    0,
  );
}

/** The cart currency, or null when empty. */
export function selectCurrency(state: CartState): Currency | null {
  return state.lines[0]?.currency ?? null;
}
