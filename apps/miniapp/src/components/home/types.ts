/**
 * Home screen section types and configuration.
 *
 * Each section is an independent module that can be enabled, disabled, or
 * reordered without touching other sections. The architecture is ready for
 * server-driven composition when needed.
 */

export type HomeSectionType =
  | 'promo_banners'
  | 'category_picker'
  | 'zone_now'
  | 'best_price'
  | 'popular'
  | 'news';

export interface HomeSectionConfig {
  type: HomeSectionType;
  enabled: boolean;
  order: number;
}

/**
 * Zone Now editorial content.
 *
 * Lives in the frontend for now — a single featured message per deploy. When
 * server-driven editorial is needed, this becomes an API response.
 */
export interface ZoneNowContent {
  title: string;
  text: string;
  imageUrl?: string;
  actionLabel?: string;
  actionUrl?: string;
}
