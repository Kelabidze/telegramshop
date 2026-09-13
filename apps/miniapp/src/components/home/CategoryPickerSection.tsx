import type { Category } from '@shop/shared';
import { CategoryGlyph } from '../CategoryGlyph.tsx';
import { haptic } from '../../telegram/webapp.ts';

/**
 * Category picker section: "Что ищешь?"
 *
 * Compact grid of category entry points, drawn with the brand's line icons.
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
              <CategoryGlyph category={category} size={22} />
            </span>
            <span className="category-picker-card__title">{category.title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
