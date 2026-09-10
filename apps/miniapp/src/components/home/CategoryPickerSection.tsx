import type { Category } from '@shop/shared';
import { haptic } from '../../telegram/webapp.ts';
import {
  IconCatalog,
  IconTarget,
  IconMediaPlaceholder,
} from '../icons/index.tsx';

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
 * Maps categories to brand icons.
 *
 * Uses the category emoji as fallback when no brand icon exists. The mapping
 * is based on slug rather than title, so it survives title changes and works
 * across languages if the shop ever becomes multilingual.
 */
function getCategoryIcon(category: Category): React.ReactNode {
  const iconMap: Record<string, React.ReactNode> = {
    'gift-codes': <IconCatalog />,
    games: <IconCatalog />,
    'app-store': <IconMediaPlaceholder />,
    crypto: <IconTarget />,
    software: <IconMediaPlaceholder />,
    access: <IconTarget />,
    web: <IconMediaPlaceholder />,
    other: <IconMediaPlaceholder />,
  };

  // Use brand icon if available, otherwise fall back to emoji.
  return iconMap[category.slug] ?? (category.emoji || '🗂');
}
