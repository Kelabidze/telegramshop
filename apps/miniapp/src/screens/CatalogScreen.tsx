import { CatalogBrowser } from '../components/CatalogBrowser.tsx';

/**
 * Home screen: promo banners, the category grid and the product grid.
 *
 * The listing itself lives in `CatalogBrowser`, which «Всё для абуза» mounts as
 * well. This screen is only the placement: which section's banners belong above
 * it and which scroll namespace its offsets are filed under.
 *
 * The greeting lives in `AppLayout`, so this screen does not load the viewer:
 * one `['me']` query for the whole app means the header and the club notices can
 * never disagree about who is looking.
 *
 * Prices are shown plainly — a single figure, no strike-throughs — but it is
 * the figure *this* viewer will be charged: the club tier for a member, the
 * standard price otherwise. Same conversion the server runs at checkout, so the
 * grid, the cart and the invoice always agree. A grid of struck-through numbers
 * would read as a sale, and the club tier is a standing rate, not a promotion.
 */
export function CatalogScreen({
  isSubscribedChannel,
  onOpenProduct,
}: {
  isSubscribedChannel: boolean;
  onOpenProduct: (slug: string) => void;
}) {
  return (
    <div className="page">
      <CatalogBrowser
        bannerSection="SHOP"
        scrollNamespace="catalog"
        isSubscribedChannel={isSubscribedChannel}
        onOpenProduct={onOpenProduct}
      />
    </div>
  );
}
