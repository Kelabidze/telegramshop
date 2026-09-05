import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/**
 * Staff / shopper mode.
 *
 * Stored, not derived from the current screen: the three shopper tabs become
 * three different staff screens, and the toggle has to survive that remap.
 * Persisted so an admin who left in staff mode comes back there — flipping it
 * every visit would make the toggle feel broken.
 *
 * The store itself does not check the role. That is the caller's job, because
 * the viewer arrives asynchronously: a persisted `true` from a previous session
 * must not paint staff screens for a buyer whose `/api/me` has not landed yet
 * (or failed). `App.tsx` ANDs this flag with `viewer.role === 'ADMIN'`.
 */

interface StaffModeState {
  enabled: boolean;
  setEnabled(next: boolean): void;
  toggle(): void;
}

export const useStaffMode = create<StaffModeState>()(
  persist(
    (set) => ({
      enabled: false,
      setEnabled(next) {
        set({ enabled: next });
      },
      toggle() {
        set((state) => ({ enabled: !state.enabled }));
      },
    }),
    { name: 'shop-staff-mode-v1' },
  ),
);
