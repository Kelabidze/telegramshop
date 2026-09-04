import type { ProfileUpdateInput, Viewer } from '@shop/shared';
import { prisma } from '../db.js';

/**
 * Profile edits the user makes about themselves.
 *
 * Only `displayName` for now. It is deliberately a separate column from
 * `firstName`: `upsertUser` rewrites the Telegram fields on every single
 * request, so a custom name stored there would survive exactly until the next
 * page load.
 */

/** Applies a rename and returns the viewer as the client should now see it. */
export async function updateDisplayName(
  viewer: Viewer,
  input: ProfileUpdateInput,
): Promise<Viewer> {
  // `null` clears the override and falls back to the Telegram name — that is
  // the "reset" the UI offers, not a way to end up with an empty header.
  const displayName = input.displayName;

  await prisma.user.update({
    where: { id: viewer.id },
    data: { displayName },
  });

  // Returned from the in-memory viewer rather than re-read: the row was just
  // written, and a second query would only add latency to confirm what we set.
  return { ...viewer, displayName };
}
