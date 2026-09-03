import { useQuery } from '@tanstack/react-query';
import type { Viewer } from '@shop/shared';
import { api } from '../api/client.ts';

/**
 * The authenticated viewer, shared by every screen.
 *
 * One query key (`['me']`) so the layout header, the product card and the cart
 * all read the same cached answer instead of each firing its own request and
 * potentially disagreeing about club membership.
 *
 * `retry: false` and a null fallback: outside Telegram this is a guaranteed
 * 401, and the catalog is public, so a failed profile must not turn into an
 * error screen. A missing viewer simply means "no club tier".
 */
export function useViewer(): {
  viewer: Viewer | null;
  isPending: boolean;
  isSubscribedChannel: boolean;
} {
  const query = useQuery({
    queryKey: ['me'],
    queryFn: () => api.getViewer(),
    // The profile changes far less often than stock does.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const viewer = query.data ?? null;
  return {
    viewer,
    isPending: query.isPending,
    isSubscribedChannel: viewer?.isSubscribedChannel ?? false,
  };
}
