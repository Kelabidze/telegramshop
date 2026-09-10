import { CatalogBrowser } from '../components/CatalogBrowser.tsx';

/**
 * «Всё для абуза».
 *
 * Currently the ordinary catalog behind its own promo banner: a full-width 1:1
 * poster, then the same categories and the same product grid as the home screen.
 * It mounts `CatalogBrowser` rather than copying it, so the two tabs cannot
 * behave differently — the filter, the scroll restoration and the price on a card
 * are one implementation.
 *
 * The country-filtered listing of section roots is **switched off, not deleted**.
 * Everything behind it is intact and still reachable: `Product.parentId` /
 * `Product.countryId` in the schema, the aggregates in `services/catalog.ts`, the
 * `section=ABUSE&country=…` filter on `GET /api/products`, and the staff tab that
 * edits roots, their country variations and the country list
 * (`screens/admin/AbuseAdminScreen`-side of things). Bringing the storefront side
 * back means rendering that listing again; nothing has to be rebuilt.
 *
 * Its banner is square while the catalog's is 16:9. The section leads with one
 * poster instead of a strip of two, and a 1:1 frame is what that artwork is cut
 * for — the cap of one lives in the contract (`BANNER_MAX_VISIBLE`), because a
 * second square poster would be the entire first screen.
 */
export function AbuseScreen({
  isSubscribedChannel,
  onOpenProduct,
}: {
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  return (
    <div className="page">
      <h1 className="title" style={{ marginBottom: 12 }}>
        Всё для абуза
      </h1>

      <CatalogBrowser
        bannerSection="ABUSE"
        bannerShape="square"
        // Own namespace despite showing the same products: returning to this tab
        // at the home screen's offset reads as a random jump.
        scrollNamespace="abuse"
        isSubscribedChannel={isSubscribedChannel}
        onOpenProduct={onOpenProduct}
      />
    </div>
  );
}
