# illustrations

Empty and error state artwork. Not yet drawn — this folder is the mount point.

`EmptyState` (`src/components/ui.tsx`) accepts either `emoji` or `art` and
renders whichever it gets inside `.empty-art`, a 96px framed tile. Every call
site still passes an emoji; that is deliberate, so nothing has to be undone when
the real artwork arrives.

## Wiring one up

```tsx
import emptyCart from '../assets/illustrations/empty-cart.svg';

<EmptyState
  art={<img className="empty-art__image" src={emptyCart} alt="" />}
  title="Корзина пуста"
  description="Добавьте товар из каталога, чтобы оформить заказ."
/>
```

One line per call site, no other change. `alt=""` because the tile is decorative
and the title next to it already carries the meaning.

## Expected files

| File                | Replaces | Call site |
| ------------------- | -------- | --------- |
| `empty-cart.svg`    | 🛒 | `screens/CartScreen.tsx` |
| `empty-orders.svg`  | 📦 | `screens/OrdersScreen.tsx` |
| `empty-search.svg`  | 🔍 | `components/CatalogBrowser.tsx` |
| `error.svg`         | ⚠️ | `components/ui.tsx` → `ErrorState` |
| `locked.svg`        | 🔐 | `screens/ProfileScreen.tsx` (viewer outside Telegram) |
| `empty-generic.svg` | 🗂 / 👥 | the three admin screens, sharing one file |

Six files, not eight: the staff screens do not each warrant their own drawing.

## Brief

- Square, designed for 96px, legible at that size — it is not a hero image
- Dark, sitting on `#15131C`; the frame supplies its own background and hairline
- One accent presence in `#E83DFF` or `#9B5CFF`, not an accent-coloured drawing
- Line-weight consistent across the set; these are seen one after another
- The octopus motif belongs here (a tentacle, a sucker), used as a detail
- No full-bleed background, no city, no scene
