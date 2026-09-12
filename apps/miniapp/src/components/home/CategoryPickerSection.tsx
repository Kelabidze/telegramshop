import type { Category } from '@shop/shared';
import { categoryIcons } from '../../assets/index.ts';
import { haptic } from '../../telegram/webapp.ts';

/**
 * Category picker section: "Что ищешь?"
 *
 * Compact grid of category entry points. Uses brand SVG icons rather than emoji
 * where they exist, falling back to category emoji when needed.
 *
 * Not a second full catalog — quick navigation into the main catalog with a
 * category filter applied.
 */
export function CategoryPickerSection({
  categories,
  onOpenCategory,
}: {
  categories: Category[];
  onOpenCategory: (slug: string) => void;
}) {
  if (categories.length === 0) return null;

  return (
    <section className="home-section">
      <h2 className="section-title">Что ищешь?</h2>
      <div className="category-picker-grid">
        {categories.map((category) => (
          <button
            key={category.id}
            type="button"
            className="category-picker-card"
            onClick={() => {
              haptic('tap');
              onOpenCategory(category.slug);
            }}
          >
            <span className="category-picker-card__icon">
              {getCategoryIcon(category)}
            </span>
            <span className="category-picker-card__title">{category.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

/**
 * Maps a category to its brand icon, falling back to the emoji staff chose.
 *
 * Keyed by slug rather than title so it survives renames. The map lives in
 * `assets/index.ts` alongside the files, and covers the seeded slugs as well as the
 * ones the pack was drawn for — the previous inline map keyed only the latter, so on
 * a seeded database every tile silently fell through to the emoji branch and three
 * of its entries pointed at the picture-frame placeholder anyway.
 *
 * The emoji fallback stays: categories are staff-editable data, so one can always
 * exist that no icon was drawn for.
 */
function getCategoryIcon(category: Category): React.ReactNode {
  const icon = categoryIcons[category.slug];
  if (icon) {
    return <img className="category-picker-card__glyph" src={icon} alt="" />;
  }
  return category.emoji || '🗂';
}
