import { invalidRequest } from './errors';

/**
 * Bounds on dialog-free external work a connected origin can trigger.
 *
 * The dialog throttle only reacts to rejected dialogs; these limits bound
 * what never shows a dialog at all: balance fan-outs, friendbot requests,
 * and the pre-dialog work (key derivation, simulation, safety lookups) that
 * parallel requests could start before any rejection is recorded.
 *
 * Like the dialog throttle this is deliberately in-memory: the snap
 * execution environment is ephemeral, so losing the counters on restart
 * merely re-allows requests — the fail-open direction for availability
 * controls.
 */

/**
 * Concurrently executing requests allowed per origin. MetaMask serializes
 * dialogs anyway, so a legitimate dapp has no use for more parallelism than
 * this; a hostile one uses it to multiply pre-dialog work.
 */
export const MAX_INFLIGHT_PER_ORIGIN = 4;

/**
 * Concurrently executing requests allowed across every origin. The
 * per-origin cap alone rotates: a site controlling a wildcard domain gets a
 * fresh budget per subdomain, so without a global ceiling parallel work
 * still multiplies with the number of origins. The ceiling also keeps the
 * per-origin tracking map inherently bounded (it can never hold more
 * origins than there are executing requests), so live counters are never
 * evicted to make room, which would silently reset an origin's budget.
 */
export const MAX_INFLIGHT_GLOBAL = 32;

/**
 * The share of {@link MAX_INFLIGHT_GLOBAL} that origins *without* a standing
 * connection grant may occupy, mirroring the {@link MAX_PREDIALOG_UNCONNECTED}
 * split below and reserving the remainder for origins the user has approved.
 *
 * The global ceiling alone is checked before the per-origin cap and is shared
 * across every origin, so it is not self-limiting the way the per-origin cap
 * is: an origin holding four slots denies service only to itself, but a site
 * rotating subdomains can hold *all* of them and deny service to every other
 * dapp. Two properties make those slots cheap to hold. MetaMask serializes
 * snap dialogs, so a request that reaches `snap_dialog` while another dialog
 * is open stays in flight, queued, without the caller doing anything further;
 * and the manifest's `maxRequestTime` lets an unresolved request occupy its
 * slot until it expires. `signMessage` reaches its dialog after only a key
 * derivation, which makes it the cheapest way to sit on a slot.
 *
 * That window is a manifest choice, not a given. It was 120 s (already below
 * the platform maximum of 180 s) and is now 60 s. The longest legitimate
 * request is a signing call whose latency is dominated by the user reading a
 * dialog, plus at most one 10-second simulation and a set of parallel 5-second
 * Horizon lookups, so 60 s still leaves substantial headroom while halving how
 * long an unanswered request can hold one of the slots this module rations.
 *
 * Splitting the ceiling by connection grant bounds that without needing to
 * tell rotated subdomains apart, because it does not try to: the reserved
 * share is reachable only by origins the user has already approved, and an
 * attacker cannot join that set silently, since a grant requires an approved
 * dialog.
 *
 * The unconnected share is deliberately small. What it costs an attacker is
 * `share / MAX_INFLIGHT_PER_ORIGIN` distinct origins, and subdomain rotation
 * makes each of those nearly free, so the share is really a divisor on how
 * many origins the attack needs, not a wall. What it costs a legitimate cold
 * caller is nothing: MetaMask serializes snap dialogs, so an honest
 * unconnected dapp has at most one or two requests in flight and never
 * approaches even this. Set at 8 (two origins' worth) rather than half the
 * ceiling for that reason, and paired with the manifest's `maxRequestTime`,
 * which bounds how long a held slot stays held.
 */
export const MAX_INFLIGHT_UNCONNECTED = 8;

/**
 * Sliding-window rate limits for methods whose external work is dialog-free
 * (or, for `addToken` and the signing methods, happens before any dialog can
 * gate it).
 */
export const RATE_LIMITS: ReadonlyMap<
  string,
  { limit: number; windowMs: number }
> = new Map([
  // Friendbot draws on a shared community service; a connected origin must
  // not be able to drain its quota against the wallet's accounts.
  ['fund', { limit: 5, windowMs: 60_000 }],
  // Each call fans out one simulation per tracked token.
  ['getBalances', { limit: 15, windowMs: 60_000 }],
  // Two metadata simulations run before the confirmation dialog, and a
  // contract ID that is not a token fails before any dialog opens, so the
  // dialog throttle alone never engages: without this limit a connected
  // origin could drive unbounded RPC traffic with bogus contract IDs.
  ['addToken', { limit: 10, windowMs: 60_000 }],
  // The signing methods are dialog-bearing, but their dialogs are not what
  // bounds their cost: each one derives a key and (for `signTransaction`)
  // fans out up to seven Horizon lookups or a Soroban simulation *before*
  // any dialog is created. `signTransaction` and `signMessage` are callable
  // without a connection grant (cold signing, SEP-43 parity); `signAuthEntry`
  // is not, because an address-credential entry always names its authorizing
  // account and naming an account is account *selection*, which is gated (see
  // `assertAccountSelectionAllowed` in ../handlers/sign.tsx). It is capped
  // here anyway: these limits bound total outbound work against shared
  // community infrastructure, not merely the unauthenticated share of it.
  // The dialog throttle only engages after three consecutive *rejections*, so
  // a caller that never lets a dialog resolve never reaches it. These caps
  // bound the pre-dialog work itself. They sit far above real signing traffic:
  // MetaMask serializes snap dialogs, so a legitimate dapp cannot approach
  // them.
  ['signTransaction', { limit: 20, windowMs: 60_000 }],
  ['signAuthEntry', { limit: 20, windowMs: 60_000 }],
  ['signMessage', { limit: 20, windowMs: 60_000 }],
  // The read-only methods perform no network work, but each one is a
  // `snap_manageState` decrypt, and none of them was bounded by anything but
  // the in-flight ceiling: a caller could spin them without limit. These caps
  // are deliberately far above real traffic rather than tight. The connector's
  // `WatchWalletChanges` polls `getAddress` and `getNetwork` on a 3-second
  // interval (20 calls a minute each), so the limits below leave a six-fold
  // margin over the busiest conformant client this snap has.
  ['getAddress', { limit: 120, windowMs: 60_000 }],
  ['getNetwork', { limit: 120, windowMs: 60_000 }],
  ['getNetworkDetails', { limit: 120, windowMs: 60_000 }],
  ['getAccounts', { limit: 60, windowMs: 60_000 }],
  ['requestAccess', { limit: 30, windowMs: 60_000 }],
]);

/**
 * Global (origin-independent) budget on the advisory network lookups that run
 * before a signing dialog: Horizon account checks and the display-verification
 * simulation.
 *
 * The per-origin limits above cannot bound these on their own. Every control
 * in this module is keyed on `origin`, and a site controlling a wildcard
 * domain gets a fresh budget per subdomain, so origin rotation multiplies
 * pre-dialog work without limit. This budget is the only one that survives
 * that, because the snap cannot distinguish `a1.example` from `a2.example`.
 *
 * Denial here is deliberately *not* an error: the callers degrade to their
 * existing "could not check" paths, which disclose the gap in the dialog
 * rather than silently dropping a warning. Throwing instead would let an
 * attacker exhaust the budget to block a legitimate signature outright, and
 * failing silently would let them exhaust it to suppress safety warnings.
 * Both are worse than a visible caution.
 */
export const MAX_PREDIALOG_LOOKUPS = 120;

/**
 * The share of {@link MAX_PREDIALOG_LOOKUPS} that origins *without* a standing
 * connection grant may consume. Origins holding a grant may draw on the full
 * budget.
 *
 * A single global pool is drainable by whoever claims first, and the claim
 * happens before any dialog opens, so it needs no user interaction at all. One
 * site rotating subdomains can therefore empty the pool in seconds and leave
 * every *other* site's signing dialog rendering the "checks were skipped"
 * advisory for the rest of the window. That is worse than it sounds: a caution
 * an attacker can make permanent and universal stops being a signal and
 * becomes noise the user learns to click past, which is exactly the state in
 * which a real unfunded-destination or SEP-29 warning goes unread.
 *
 * Splitting the pool by connection grant fixes that without needing to tell
 * rotated subdomains apart, because it does not try to. The reserved half is
 * reachable only by origins the user has already approved, and an attacker
 * cannot join that set silently: a grant requires an approved dialog. Cold
 * callers keep exactly the budget they had before this split (60), so the
 * anti-amplification bound on the unauthenticated surface is unchanged; the
 * headroom added above it is gated behind user consent.
 *
 * Cold signing by a legitimate first-time dapp draws on the unreserved share
 * and can still be denied under attack. That degrades to the same visible
 * caution as before, which is the accepted trade-off: the alternative is
 * trusting origin strings the snap has no way to verify.
 */
export const MAX_PREDIALOG_UNCONNECTED = 60;

export const PREDIALOG_WINDOW_MS = 60_000;

/**
 * Global budget on the token-balance simulation fan-out, kept deliberately
 * SEPARATE from the pre-dialog budget above rather than sharing its pool.
 *
 * `getBalances` runs one simulation per tracked token, so a single call can
 * cost up to {@link MAX_TRACKED_TOKENS} round trips, and its rate limit allows
 * 15 calls a minute. That is the largest outbound fan-out any RPC method can
 * cause, and neither the per-origin rate limit nor the 5-second coalescing
 * cache in `handlers/account.tsx` bounds it: the cache is keyed by address, and
 * a connected origin learns every revealed address from `getAccounts`.
 *
 * Why not simply claim `takePredialogBudget`: the two budgets protect
 * different things, and merging them would let each break the other. The
 * pre-dialog budget exists so that safety warnings and the display simulation
 * are still available when a signing dialog is built, and this module already
 * argues that a caution an attacker can make permanent stops being a signal.
 * A wallet tracking 30 tokens would exhaust the 120-slot pre-dialog pool in
 * four `getBalances` calls, so an ordinary polling dapp would degrade the
 * user's own signing dialogs to "checks were skipped" as a side effect of
 * refreshing balances. A separate pool bounds the fan-out without putting
 * display integrity on the same meter.
 *
 * Sized above any real polling client (a few tokens refreshed a few times a
 * minute) and below the 450/minute a connected origin could otherwise drive.
 */
export const MAX_TOKEN_READ_LOOKUPS = 300;

/** Timestamps of recent pre-dialog lookups, across every origin. */
const predialogLog: number[] = [];

/** Timestamps of recent token-balance simulations, across every origin. */
const tokenReadLog: number[] = [];

/**
 * Claims `count` slots from a sliding-window budget, dropping entries that
 * have aged out first. All or nothing: a claim that would exceed the ceiling
 * records nothing, so a denied caller does not push the window forward and
 * turn a throttle into a lockout.
 *
 * @param log - The window's timestamp log, mutated in place.
 * @param ceiling - The maximum entries allowed in the window.
 * @param count - How many slots the caller is about to use.
 * @param windowMs - The window length in milliseconds.
 * @returns True when the budget allowed them (and they were recorded).
 */
function takeWindowedBudget(
  log: number[],
  ceiling: number,
  count: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const windowStart = now - windowMs;
  while (log.length > 0 && (log[0] as number) <= windowStart) {
    log.shift();
  }
  if (log.length + count > ceiling) {
    return false;
  }
  for (let index = 0; index < count; index += 1) {
    log.push(now);
  }
  return true;
}

/**
 * Claims `count` slots from the global pre-dialog lookup budget.
 *
 * @param connected - Whether the requesting origin holds a standing connection
 * grant. Unconnected origins are capped at {@link MAX_PREDIALOG_UNCONNECTED}
 * so the cold-callable surface cannot starve connected sites of their checks.
 * @param count - How many lookups the caller is about to perform.
 * @returns True when the budget allowed them (and they were recorded).
 */
export function takePredialogBudget(connected: boolean, count = 1): boolean {
  return takeWindowedBudget(
    predialogLog,
    connected ? MAX_PREDIALOG_LOOKUPS : MAX_PREDIALOG_UNCONNECTED,
    count,
    PREDIALOG_WINDOW_MS,
  );
}

/**
 * Claims `count` slots from the global token-balance simulation budget.
 *
 * Claimed only on the dapp-reachable path (`getBalances`). The snap home page
 * runs the same fan-out but does not claim: it is reached only by the user
 * opening their own wallet UI, so it is not a surface an origin can drive, and
 * making it draw on this pool would hand a dapp a way to blank the user's own
 * balance rows.
 *
 * @param count - How many token reads the caller is about to perform.
 * @returns True when the budget allowed them (and they were recorded).
 */
export function takeTokenReadBudget(count: number): boolean {
  return takeWindowedBudget(
    tokenReadLog,
    MAX_TOKEN_READ_LOOKUPS,
    count,
    PREDIALOG_WINDOW_MS,
  );
}

/**
 * Cap on tracked origins so an attacker rotating origins cannot grow the
 * request-window map without bound. The *least recently used* entry is
 * evicted; eviction only ever forgets counts, so it fails open, never
 * closed. The in-flight map is bounded by the global in-flight ceiling
 * instead and is never evicted.
 */
const MAX_TRACKED_ORIGINS = 100;

/** Request timestamps per `origin method` key (sliding window). */
const requestLog = new Map<string, number[]>();

/**
 * Currently executing request count per origin. Entries are removed when
 * their count reaches zero and the global in-flight ceiling bounds the
 * total, so unlike {@link requestLog} this map needs no eviction: every
 * entry is a live counter, and evicting one would reset an origin's budget
 * mid-flight.
 */
const inflight = new Map<string, number>();

/** Currently executing request count across every origin. */
let inflightTotal = 0;

/**
 * Evicts the least recently used entry when a bounded map is full.
 *
 * A `Map` iterates in insertion order, so "least recently used" only holds if
 * every touch re-inserts its key. {@link touch} is what maintains that; this
 * function relies on it. Evicting by raw insertion order instead would let an
 * attacker rotating origins evict an *active* origin's counters, which is the
 * one entry that must survive.
 *
 * @param map - The tracking map.
 */
function evictIfFull(map: Map<string, unknown>): void {
  if (map.size >= MAX_TRACKED_ORIGINS) {
    const leastRecent = map.keys().next().value;
    if (leastRecent !== undefined) {
      map.delete(leastRecent);
    }
  }
}

/**
 * Moves an existing key to the most-recently-used end of a map. `Map.set` on
 * a key that is already present keeps its original position, so the delete is
 * what actually reorders it.
 *
 * @param map - The tracking map.
 * @param key - The key being used right now.
 */
function touch<Type>(map: Map<string, Type>, key: string): void {
  if (map.has(key)) {
    map.delete(key);
  }
}

/**
 * Enforces the sliding-window rate limit for a method, recording the request
 * when it is allowed.
 *
 * @param origin - The requesting dapp origin.
 * @param method - The RPC method name.
 * @throws An invalid-request error naming the wait when over the limit.
 */
export function assertRateAllowed(origin: string, method: string): void {
  const config = RATE_LIMITS.get(method);
  if (!config) {
    return;
  }
  const key = `${origin} ${method}`;
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const known = requestLog.has(key);
  const recent = (requestLog.get(key) ?? []).filter(
    (time) => time > windowStart,
  );
  // Refresh recency for every request from a known key, including the ones
  // about to be refused. Refreshing only on the allowed path would leave a
  // throttled caller's window at the least-recently-used end, where rotating
  // origins evict it: since eviction fails open, that hands the caller a way
  // to clear its own throttle by simply making more requests.
  if (known) {
    touch(requestLog, key);
  } else {
    evictIfFull(requestLog);
  }

  if (recent.length >= config.limit) {
    const oldest = recent[0] ?? now;
    const seconds = Math.max(
      1,
      Math.ceil((oldest + config.windowMs - now) / 1000),
    );
    // Re-insert the window before refusing: `touch` removed it, and dropping
    // it here would reset the very limit being enforced. The refused request
    // is deliberately not recorded, since counting it would keep extending
    // the window and turn a throttle into a lockout.
    requestLog.set(key, recent);
    throw invalidRequest(
      `Too many ${method} requests from this site. Try again in ${seconds}s.`,
    );
  }

  recent.push(now);
  requestLog.set(key, recent);
}

/**
 * Runs a handler under the origin's in-flight budget: the request is refused
 * up front when the origin already has {@link MAX_INFLIGHT_PER_ORIGIN}
 * requests executing, so parallel calls cannot multiply pre-dialog external
 * work without bound.
 *
 * The global ceiling is split by connection grant
 * ({@link MAX_INFLIGHT_UNCONNECTED}), so a cold-callable origin rotating
 * subdomains cannot occupy every slot and deny service to connected sites.
 *
 * @param origin - The requesting dapp origin.
 * @param fn - The handler body.
 * @param isConnected - Resolves whether the origin holds a standing grant.
 * Passed as a thunk, not a value, because reading it costs a
 * `snap_manageState` decrypt: it is consulted only once concurrency has
 * already reached the unconnected share, so the common path stays free.
 * @returns The handler result.
 */
export async function withInflightBudget<Type>(
  origin: string,
  fn: () => Promise<Type>,
  isConnected: () => Promise<boolean> = async () => false,
): Promise<Type> {
  // Resolve the grant before any check, so every check below (and the
  // increment that follows them) runs synchronously. Awaiting *between* a
  // check and the increment would let concurrent requests all observe the
  // same pre-increment total and overshoot the ceiling together.
  const connected =
    inflightTotal >= MAX_INFLIGHT_UNCONNECTED ? await isConnected() : false;

  // The global ceiling is checked first: it holds regardless of how many
  // origins the caller can mint, which is exactly the case the per-origin
  // cap cannot cover.
  const ceiling = connected ? MAX_INFLIGHT_GLOBAL : MAX_INFLIGHT_UNCONNECTED;
  if (inflightTotal >= ceiling) {
    throw invalidRequest(
      'The wallet is handling too many concurrent requests. Wait for the pending ones to finish.',
    );
  }
  const current = inflight.get(origin) ?? 0;
  if (current >= MAX_INFLIGHT_PER_ORIGIN) {
    throw invalidRequest(
      'Too many concurrent requests from this site. Wait for the pending ones to finish.',
    );
  }
  inflight.set(origin, current + 1);
  inflightTotal += 1;
  try {
    return await fn();
  } finally {
    inflightTotal -= 1;
    const count = (inflight.get(origin) ?? 1) - 1;
    if (count <= 0) {
      inflight.delete(origin);
    } else {
      inflight.set(origin, count);
    }
  }
}

/** Resets all tracking. Test hook. */
export function resetRequestLimits(): void {
  requestLog.clear();
  inflight.clear();
  inflightTotal = 0;
  predialogLog.length = 0;
  tokenReadLog.length = 0;
}
