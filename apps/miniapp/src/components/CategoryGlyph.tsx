import { categoryIcon } from '../assets/index.ts';

/**
 * A category's brand icon, in the colour of its surroundings.
 *
 * Drawn as a CSS mask rather than an `<img>`, and that is the whole point of the
 * component. The pack's icons are stroked in `#E83DFF`, and an `<img>` is an isolated
 * document — `currentColor` does not reach inside it. Loaded as an image, every tile
 * therefore wore the accent at full strength: eight saturated magenta glyphs in one
 * grid, with no way to say "this one is selected" and no way to keep the rest quiet.
 *
 * As a mask only the alpha channel is used, so the shape survives and the colour comes
 * from CSS. That is what lets the picker follow the accent budget: muted by default,
 * magenta on the tile the user chose.
 *
 * `-webkit-mask` is not optional. Telegram runs on WebViews old enough to need the
 * prefix, and there the unprefixed property alone renders nothing at all — a mask that
 * silently fails takes the icon with it.
 */
export function CategoryGlyph({
  category,
  size = 22,
}: {
  category: { slug: string; title: string };
  /** Rendered edge length in px. The art is square. */
  size?: number;
}) {
  const url = `url(${JSON.stringify(categoryIcon(category))})`;

  return (
    <span
      className="category-glyph"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        WebkitMaskImage: url,
        maskImage: url,
      }}
    />
  );
}
