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

/**
 * Dialogs an origin may open without a single approval before it is put on
 * cooldown, counting the ones that are never answered at all.
 *
 * The rejection counter above only advances on an explicit SEP-43 `-4`, which
 * requires the user to actually press reject. A hostile origin can avoid it
 * entirely by summoning dialogs the user simply ignores: the request then
 * unwinds when the platform's `maxRequestTime` expires, the snap observes no
 * rejection, and the cooldown never engages however many dialogs pile up. That
 * is the cheaper attack, because it costs the attacker nothing and costs the
 * user the whole queue.
 *
 * Counting *opens* closes that gap: the count advances the moment a dialog is
 * created, whatever becomes of it. The threshold sits above
 * {@link MAX_CONSECUTIVE_REJECTIONS} so an ordinary reject-then-retry user
 * still trips the rejection rule first (which carries the more accurate
 * message), and so a legitimate site that opens several dialogs in a row has
 * room before the coarser rule applies. Any approval clears both counters.
 */
export const MAX_UNANSWERED_DIALOGS = 6;

/** Cooldown length once the rejection threshold is reached. */
export const COOLDOWN_MS = 30_000;

/**
 * Cap on tracked origins so an attacker rotating origins cannot grow the
 * map without bound. The *least recently used* entry is evicted; eviction
 * only ever forgets rejections, so it fails open, never closed.
 *
 * Recency matters here more than in the rate limiter. Eviction releases a
 * cooldown, so evicting by raw insertion order would hand an origin a way to
 * clear its *own* cooldown: rotate through 100 throwaway origins and the
 * entry recording the block is gone. Touching an entry on every access keeps
 * the origin currently making requests at the most-recently-used end, where
 * it cannot be evicted.
 */
export const MAX_TRACKED_ORIGINS = 100;

type ThrottleEntry = {
  /** Consecutive rejections since the last approval or expired cooldown. */
  rejections: number;
  /**
   * Dialogs opened since the last approval, answered or not. Unlike
   * {@link ThrottleEntry.rejections} this advances without user action, which
   * is what makes it reach an origin whose dialogs are never answered.
   */
  opened: number;
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
    // Re-insert so the entry moves to the most-recently-used end: `Map.set`
    // alone would keep its original position.
    entries.delete(origin);
    entries.set(origin, existing);
    return existing;
  }
  if (entries.size >= MAX_TRACKED_ORIGINS) {
    const leastRecent = entries.keys().next().value;
    if (leastRecent !== undefined) {
      entries.delete(leastRecent);
    }
  }
  const created = { rejections: 0, opened: 0, blockedUntil: 0 };
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
  // A blocked origin that keeps calling keeps its entry fresh, so it cannot
  // rotate other origins in to evict the record of its own cooldown.
  entries.delete(origin);
  entries.set(origin, entry);
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
    entry.opened = 0;
    entry.blockedUntil = Date.now() + COOLDOWN_MS;
  }
}

/**
 * Records that the origin is about to be shown a dialog, whatever becomes of
 * it. Handlers call this immediately before `snap_dialog`.
 *
 * This is the counter that reaches an origin whose dialogs are never answered
 * (see {@link MAX_UNANSWERED_DIALOGS}): it advances at creation time, so it
 * does not depend on the user pressing anything, and a request abandoned when
 * the platform request timeout expires still leaves its mark.
 *
 * @param origin - The requesting dapp origin.
 */
export function recordDialogOpened(origin: string): void {
  const entry = entryFor(origin);
  entry.opened += 1;
  if (entry.opened >= MAX_UNANSWERED_DIALOGS) {
    entry.opened = 0;
    entry.rejections = 0;
    entry.blockedUntil = Date.now() + COOLDOWN_MS;
  }
}

/**
 * Clears the origin's throttle state after an *approved* dialog: both the
 * consecutive-rejection count and the unanswered-dialog count, since an
 * approval breaks either chain and is positive evidence that the origin's
 * dialogs are reaching a user who engages with them.
 *
 * Handlers call this at the moment the user approves, never on a mere
 * handler success: several dialog-bearing methods have success paths that
 * show no dialog at all (`setNetwork` to the current network,
 * `setActiveAccount` to the active index, `requestAccess` with a standing
 * grant), and clearing on those would let a connected origin reset its
 * rejection count between rejections and never reach the cooldown.
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
