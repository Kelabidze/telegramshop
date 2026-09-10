# logo

The OCHKISK ZONE mark. Not yet drawn — this folder is the mount point.

## Expected files

| File            | What | Used by |
| --------------- | ---- | ------- |
| `wordmark.svg`  | Full lockup, horizontal | `ProfileScreen`, once, at the end of the screen |
| `mark.svg`      | Compact sign, square, no wordmark | favicon source, app icon, `IconMediaPlaceholder` replacement |

Two files because they are two drawings: a wordmark scaled down to 18px is
illegible, and a sign stretched wide is not a logo.

## Where branding goes, and where it does not

Once, at the foot of the profile. That is the only place in the app.

`.brand-signature` in `styles.css` is the slot, already styled (centred, 18px
tall, 55% opacity). Wiring it up:

```tsx
import wordmark from '../assets/logo/wordmark.svg';

<div className="brand-signature">
  <img className="brand-signature__mark" src={wordmark} alt="OCHKISK ZONE" />
</div>
```

Not in the header: that strip is the user's own profile, and Telegram already
shows the bot's name and avatar directly above it in native chrome. A logo there
would be the third identity in 80 pixels.

Not on the catalogue, cart, orders or product screens. Someone shopping knows
which shop they are in; a mark on every screen spends attention that the products
need.

`mark.svg` is also the source for the app icons in `../../../public/` (see the
commented-out `<link>` block in `index.html`).

## Brief

- Works in one colour, and works filled — the favicon has no room for a hairline
- Legible at 18px, and as a 16px favicon
- The octopus motif is the brand; the compact sign is presumably built from it
- No gradient in `mark.svg`: it is rasterised down to 16px
