# illustrations

Empty and error state artwork, from the approved asset pack.

`EmptyState` (`src/components/ui.tsx`) accepts either `emoji` or `art` and renders
whichever it gets inside `.empty-art`, a 132px framed tile.

## Wiring one up

```tsx
import { emptyArt } from '../assets/index.ts';

<EmptyState
  art={<EmptyArt src={emptyArt.cart} />}
  title="Корзина пуста"
  description="Добавьте товар из каталога, чтобы оформить заказ."
/>
```

One line per call site. `alt=""` because the tile is decorative and the title next to it
already carries the meaning.

## Files

| File                | Call site |
| ------------------- | --------- |
| `empty-cart.svg`    | `screens/CartScreen.tsx` |
| `empty-orders.svg`  | `screens/OrdersScreen.tsx` |
| `empty-search.svg`  | `components/CatalogBrowser.tsx` — an empty category or search |
| `error.svg`         | `components/ui.tsx` → `ErrorState`, so every failed query on every screen |
| `locked.svg`        | `screens/ProfileScreen.tsx`, viewer outside Telegram |

Five files. The three staff screens keep their emoji: they are not a buyer-facing
surface, and inventing a sixth drawing for them would be brand work spent where nobody
shopping will ever see it.

## Sizing

`.empty-art__image` pads by 12px and uses `object-fit: contain`. Both matter: the
drawings are 4:3 in a square tile, so they already lose height to letterboxing, and more
padding on top of that shrinks the artwork until the octopus detail in each one stops
being readable — which is the only reason these are illustrations and not glyphs.

## Brief

- Square, designed for 96px, legible at that size — it is not a hero image
- Dark, sitting on `#15131C`; the frame supplies its own background and hairline
- One accent presence in `#E83DFF` or `#9B5CFF`, not an accent-coloured drawing
- Line-weight consistent across the set; these are seen one after another
- The octopus motif belongs here (a tentacle, a sucker), used as a detail
- No full-bleed background, no city, no scene
