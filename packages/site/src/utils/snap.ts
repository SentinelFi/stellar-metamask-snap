import { defaultSnapOrigin, defaultSnapVersion } from '../config';
import type { Snap } from '../types';

/**
 * Check if a snap ID is a local snap ID.
 *
 * @param snapId - The snap ID.
 * @returns True if it's a local Snap, or false otherwise.
 */
export const isLocalSnap = (snapId: string) => snapId.startsWith('local:');

/** The longest version string the page will store or display. */
const MAX_VERSION_LENGTH = 32;

/**
 * Whether a `wallet_getSnaps` entry has the shape this page relies on.
 *
 * The entry is provider-reported, and the provider object is discovered from
 * the page environment, so it is validated rather than cast: the version is
 * the one field the page compares and renders, and it must be a bounded
 * string, not whatever was sent.
 *
 * @param value - The raw entry.
 * @returns True when the entry carries a bounded version string.
 */
export const isSnapEntry = (value: unknown): value is Snap =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { version?: unknown }).version === 'string' &&
  (value as { version: string }).version.length > 0 &&
  (value as { version: string }).version.length <= MAX_VERSION_LENGTH;

/**
 * Whether an installed snap is the exact release this site was built for.
 *
 * `wallet_getSnaps` reports whatever version is already installed under the
 * configured ID; treating any of them as suitable would let an older
 * (possibly vulnerable) release run behind a site that represents itself as
 * the audited one. The judgement is made on the origin this build was
 * configured with, never on the `id` field inside the entry: that field is
 * provider-reported and was read under the configured key anyway, so it can
 * only widen the exemption, never narrow it. A local development origin is
 * unversioned and exempt, as is a build without a pinned version (the
 * production build guard requires one, so that only happens in development).
 *
 * @param snap - The installed snap entry.
 * @returns True when the installed version may be used.
 */
export const isExpectedSnapVersion = (snap: Snap): boolean => {
  if (isLocalSnap(defaultSnapOrigin)) {
    return true;
  }
  if (!defaultSnapVersion) {
    return true;
  }
  return snap.version === defaultSnapVersion;
};
