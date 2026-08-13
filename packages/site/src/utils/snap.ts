import { defaultSnapOrigin, defaultSnapVersion } from '../config';
import type { Snap } from '../types';

/**
 * Check if a snap ID is a local snap ID.
 *
 * @param snapId - The snap ID.
 * @returns True if it's a local Snap, or false otherwise.
 */
export const isLocalSnap = (snapId: string) => snapId.startsWith('local:');

/**
 * Whether an installed snap is the exact release this site was built for.
 *
 * `wallet_getSnaps` reports whatever version is already installed under the
 * configured ID; treating any of them as suitable would let an older
 * (possibly vulnerable) release run behind a site that represents itself as
 * the audited one. Local snaps are unversioned development builds and are
 * exempt, as is a build without a pinned version (the production build
 * guard requires one, so that only happens in development).
 *
 * @param snap - The installed snap entry.
 * @returns True when the installed version may be used.
 */
export const isExpectedSnapVersion = (snap: Snap): boolean => {
  if (isLocalSnap(snap.id) || isLocalSnap(defaultSnapOrigin)) {
    return true;
  }
  if (!defaultSnapVersion) {
    return true;
  }
  return snap.version === defaultSnapVersion;
};
