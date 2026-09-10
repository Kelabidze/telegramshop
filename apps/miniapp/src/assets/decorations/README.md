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
| `tentacle-arc.svg` | `--zone-decor-tentacle`   | `.profile-hero::before`, 140px tall, 10% opacity, clipped by the container |
| `suction-row.svg`  | `--zone-decor-suction`    | not yet applied — intended as a small marker before `.section-title` |
| `noise.png`        | `--zone-decor-noise`      | not yet applied — intended as a tiling grain overlay |

## Wiring one up

Change the variable in `styles.css` from `none` to a `url()`:

```css
--zone-decor-tentacle: url('./assets/decorations/tentacle-arc.svg');
```

Relative to `styles.css`, so Vite rewrites and hashes it. `.profile-hero::before`
already exists and will start rendering; nothing else changes.

## Two open decisions

**`suction-row.svg`** has no rule yet. A repeating marker on every section
heading appears 4-6 times per screen, which is more brand presence than the
budget allows. Worth trying, worth reverting.

**`noise.png`** is the only planned raster asset, and it is the only one with a
performance cost: a fixed full-viewport overlay measurably hurts scrolling on
some Android WebViews. If it goes in, it must be verified on a real mid-range
Android device before it stays. 128×128, alpha, 3-5% opacity.

## Brief

- Decoration is decoration: it must survive being 10% visible
- No composition that reads as a scene, and no city
- The octopus motif here is a fragment — an arc of tentacle leaving the frame,
  a row of suckers — not a whole creature
- Never full-screen behind content: these are local, edge-anchored accents
