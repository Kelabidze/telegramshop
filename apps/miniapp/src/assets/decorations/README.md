# decorations

Background graphics for the brand layer. Not yet drawn — this folder is the
mount point.

These are wired differently from illustrations: they are referenced from CSS, not
imported by a component, so each has a variable in `:root` that is `none` until
the file exists. A `background-image` pointing at a missing file is a 404 per
element, so absence has to be the default.

## Expected files

| File               | CSS variable              | Applied to |
| ------------------ | ------------------------- | ---------- |
| `tentacle-arc.svg` | `--zone-decor-tentacle`   | `.profile-hero::before` (140px, 0.14) and `.zone-now-card::before` (right-anchored, 0.16); both `contain`, both clipped |
| `suction-row.svg`  | `--zone-decor-suction`    | not applied — see below |
| `noise.png`        | `--zone-decor-noise`      | not applied — see below |

## Wiring one up

The variable is set from `main.tsx` (`applyDecor`), not in the stylesheet, so the URL
comes from a Vite import and a rename becomes a build error instead of a silent 404.

**Quote the URL.** Vite inlines these SVGs as data URIs, and `tentacle-arc.svg`
contains literal apostrophes plus a nested `url(%23g)` for its gradient — so
`url(<uri>)` unquoted is not a parseable CSS value:

```ts
// right: parses, renders
root.style.setProperty('--zone-decor-tentacle', `url("${decor.tentacleArc}")`);
// wrong: setProperty silently keeps the old value, decoration never appears
root.style.setProperty('--zone-decor-tentacle', `url(${decor.tentacleArc})`);
```

`setProperty` does not throw or warn on an unparseable value, it just keeps the
previous one — so this failed completely silently on every device for the whole time
the decoration was "wired up". `bundle.test.ts` asserts the quotes are there.

**Use `contain`, not `cover`.** The arc is 900×500 and the strips it sits in are around
390×140. Covering scales it to two and a half times the band's height and shows a slice
through the middle of a 90px stroke, which reads as a stray diagonal line.

## Two settled decisions

**`suction-row.svg`** stays unapplied. The intended slot was a marker before every
`.section-title`, and Home alone has four of them — a brand mark repeated four to six
times per screen is not a signature, it is a pattern, and it competes with the products
underneath. The file is not committed.

**`noise`** stays unapplied. The pack ships it as an SVG `feTurbulence` filter rather
than the tiling PNG this note originally anticipated, which is worse for the purpose: a
full-viewport filtered layer is recomputed on composite, and it measurably hurts
scrolling on mid-range Android WebViews. The interface is already dark surfaces with
hairline borders; grain adds nothing that spacing does not.

Same reasoning retires `backgrounds/grid.svg` and `decorations/glow.svg`. The grid is a
40px magenta lattice, which is the generic-cyberpunk register the brand avoids, and glow
is a radial magenta gradient — something CSS does natively in the three places that
want it, with no request and no extra layer.

## Brief

- Decoration is decoration: it must survive being 10% visible
- No composition that reads as a scene, and no city
- The octopus motif here is a fragment — an arc of tentacle leaving the frame,
  a row of suckers — not a whole creature
- Never full-screen behind content: these are local, edge-anchored accents
