# logo

The OCHKISK ZONE mark.

## Files

| File            | What | Used by |
| --------------- | ---- | ------- |
| `mark.svg`      | Compact sign, square, carries its own `#08070C` plate | `ProfileScreen` signature, `public/favicon.svg`, source for `apple-touch-icon.png` |
| `wordmark.svg`  | **Not committed.** The pack's copy sets its letters with `<text font-family="Arial Black">` | — the name is CSS type instead |

The wordmark is deliberately absent. An SVG loaded through `<img>` is an isolated
document that cannot see the app's fonts, and Arial Black ships on neither Android nor
iOS — so the shop's own name would render in whatever each platform substituted, which
is the one string that cannot be allowed to look accidental. `.brand-signature__wordmark`
sets it in the app's own display face at 0.22em tracking. Type belongs to CSS; the
drawing belongs to the SVG.

The mark's `border-radius` in CSS must stay at `rx="52" ÷ 256 × rendered size` (9px at
44px). The rounded plate is part of the artwork, so a disagreeing radius clips its
corners and leaves a visibly uneven edge.

## Where branding goes, and where it does not

Once, at the foot of the profile (`.brand-signature`). That is the only place in the app
where the mark appears as a logo.

Not in the header: that strip is the user's own profile, and Telegram already
shows the bot's name and avatar directly above it in native chrome. A logo there
would be the third identity in 80 pixels.

Not on the catalogue, cart, orders or product screens. Someone shopping knows
which shop they are in; a mark on every screen spends attention that the products
need.

Not as a product-image fallback either. A branded placeholder on every unillustrated
product turns the logo into the most repeated element in the grid and reads as artwork
the shop forgot to upload; `IconMediaPlaceholder` stays a quiet picture frame.

`mark.svg` is also the source for `public/favicon.svg` (copied verbatim) and for
`public/apple-touch-icon.png` (`node tools/build-apple-touch-icon.mjs`). Regenerate the
PNG when the mark changes — iOS ignores an SVG for the home-screen icon.

## Brief

- Works in one colour, and works filled — the favicon has no room for a hairline
- Legible at 18px, and as a 16px favicon
- The octopus motif is the brand; the compact sign is presumably built from it
- No gradient in `mark.svg`: it is rasterised down to 16px
