import { invalidRequest } from './errors';

/**
 * Methods whose handlers can open a confirmation dialog. These are the
 * dialog-fatigue surface: a hostile origin can summon them cold, so repeated
 * consecutive rejections earn the origin a short cooldown.
 */
export const DIALOG_METHODS = new Set([
  'requestAccess',
  'setNetwork',
  'signTransaction',
  'signAuthEntry',
  'signMessage',
  'addToken',
  'setActiveAccount',
]);

/** Consecutive user rejections before an origin is put on cooldown. */
export const MAX_CONSECUTIVE_REJECTIONS = 3;

/** Cooldown length once the rejection threshold is reached. */
export const COOLDOWN_MS = 30_000;

/**
 * Cap on tracked origins so an attacker rotating origins cannot grow the
 * map without bound. Oldest entries are evicted first; eviction only ever
 * forgets rejections, so it fails open, never closed.
 */
const MAX_TRACKED_ORIGINS = 100;

type ThrottleEntry = {
  /** Consecutive rejections since the last approval or expired cooldown. */
  rejections: number;
  /** Epoch ms until which dialog-bearing requests are refused (0 = none). */
  blockedUntil: number;
};

/**
 * Per-origin rejection tracking. Deliberately in-memory: the snap execution
 * environment is ephemeral, so this is best-effort dialog-fatigue relief,
 * not a persisted security control. Losing it on restart merely re-allows
 * dialogs, which is the fail-open direction.
 */
const entries = new Map<string, ThrottleEntry>();

/**
 * Fetches (or creates) the tracking entry for an origin, evicting the
 * oldest entry when the map is full.
 *
 * @param origin - The requesting dapp origin.
 * @returns The origin's mutable entry.
 */
function entryFor(origin: string): ThrottleEntry {
  const existing = entries.get(origin);
  if (existing) {
    return existing;
  }
  if (entries.size >= MAX_TRACKED_ORIGINS) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) {
      entries.delete(oldest);
    }
  }
  const created = { rejections: 0, blockedUntil: 0 };
  entries.set(origin, created);
  return created;
}

/**
 * Throws when the origin is on cooldown for dialog-bearing methods. An
 * expired cooldown clears the origin's slate.
 *
 * @param origin - The requesting dapp origin.
 * @throws An invalid-request error naming the remaining cooldown.
 */
export function assertDialogAllowed(origin: string): void {
  const entry = entries.get(origin);
  if (!entry || entry.blockedUntil === 0) {
    return;
  }
  const now = Date.now();
  if (now >= entry.blockedUntil) {
    entries.delete(origin);
    return;
  }
  const seconds = Math.ceil((entry.blockedUntil - now) / 1000);
  throw invalidRequest(
    `Too many rejected requests from this site. Try again in ${seconds}s.`,
  );
}

/**
 * Records a user rejection for the origin; the threshold starts a cooldown.
 *
 * @param origin - The requesting dapp origin.
 */
export function recordDialogRejection(origin: string): void {
  const entry = entryFor(origin);
  entry.rejections += 1;
  if (entry.rejections >= MAX_CONSECUTIVE_REJECTIONS) {
    entry.rejections = 0;
    entry.blockedUntil = Date.now() + COOLDOWN_MS;
  }
}

/**
 * Clears the origin's consecutive-rejection count after a completed
 * dialog-bearing request (an approval breaks the "consecutive" chain).
 *
 * @param origin - The requesting dapp origin.
 */
export function clearDialogRejections(origin: string): void {
  entries.delete(origin);
}

/** Resets all tracking. Test hook. */
export function resetDialogThrottle(): void {
  entries.clear();
}
