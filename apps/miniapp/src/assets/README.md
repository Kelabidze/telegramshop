# assets

Bundled UI artwork for the OCHKISK ZONE visual layer.

Everything here is imported from TypeScript, so Vite hashes the filename and
Caddy serves it from `/assets/*` with `Cache-Control: immutable` for a year
(`deploy/Caddyfile`). Replacing a file therefore changes its URL, and no cache
has to be cleared.

Not here:

- **Product and banner images.** Those are content, uploaded by staff through
  `MediaPicker` → `POST /api/media`, stored in `UPLOADS_DIR` outside the release
  and served from `/uploads/*`. They must never be committed.
- **Icons that need `currentColor`.** Tab icons and the media placeholder are
  React components in `src/components/icons/`, because an `<img>` cannot inherit
  a colour, and the tab bar expresses active/inactive by colour alone.
- **Files that need a fixed URL** (favicon, apple-touch-icon). Those belong in
  `apps/miniapp/public/`, which does not exist yet — create it when the app icon
  is ready. Vite copies that folder to the root of `dist` **verbatim**, so
  anything placed there is publicly served: icons and manifests only, no notes,
  and nothing that Vite could otherwise hash. `index.html` already carries the
  `<link>` tags, commented out.

## Constraints that apply to every asset

- **SVG is the default.** The palette is fixed and dark, so hard-coded colours
  are safe and no light-theme variant is needed. Use `currentColor` only for
  artwork that must follow a CSS colour.
- **No external references.** The production CSP is `default-src 'self'`, so an
  SVG may not fetch a font, an image or a script.
- **PNG/WebP only for genuinely raster work** — noise, grain, photographic
  texture. Nothing else.
- **No text as image.**
- Keep files small: these load on a phone, often on mobile data.

## Palette for artwork

```
background   #08070C    surfaces  #111017 / #15131C / #1B1823
text         #F5F1F7    secondary #9A94A3    muted #6E6877
accent       #E83DFF    secondary accent #9B5CFF
```

Accent is for detail, not for fills. An illustration that is mostly magenta will
look wrong next to an interface that is 90% graphite.
