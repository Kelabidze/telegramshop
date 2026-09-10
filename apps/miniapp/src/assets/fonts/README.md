# fonts

Self-hosted display face for headings. Not yet chosen — this folder is the mount
point.

The body text stays on the system stack (`--zone-font-body`): zero bytes, no
FOUT in the content people actually read, and the best rendering on both iOS and
Android. Only headings, the header name and prices are branded, through
`--zone-font-display`.

Today `--zone-font-display` points at the body stack, so the app already renders
correctly with no font file present.

## Wiring one up

Two edits in `styles.css`, nothing else:

```css
@font-face {
  font-family: 'Zone Display';
  src: url('./assets/fonts/<file>.woff2') format('woff2');
  font-weight: 400 700;   /* or a single weight */
  font-style: normal;
  font-display: swap;     /* system stack shows first; no invisible heading */
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+2000-206F,
                 U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
```

then

```css
--zone-font-display: 'Zone Display', var(--zone-font-body);
```

The fallback in that list matters: it is what renders during `swap` and if the
file ever fails to load.

## Requirements

- **WOFF2, self-hosted, in this folder.** The production CSP is
  `default-src 'self'` with no `font-src`, so Google Fonts and every other CDN is
  blocked. This is not a preference, it is enforced.
- **Cyrillic is mandatory.** The entire UI is Russian. Verify the actual file,
  not the specimen page: a face can advertise Cyrillic and ship without `ё`, `й`
  or the italic set.
- **Subset to Latin + Cyrillic**, one or two weights. Target under 40 KB.
- **Licence must permit web embedding** (OFL and similar). Record which licence
  in the commit that adds the file.
- Check the digits: prices are set in this face with `tabular-nums`, so the font
  needs real tabular figures rather than a synthesised approximation.
