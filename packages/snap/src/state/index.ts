import {
  array,
  enums,
  is,
  literal,
  number,
  object,
  optional,
  record,
  refine,
  size,
  string,
} from '@metamask/superstruct';

import type { NetworkConfig, NetworkName } from './networks';
import { NETWORK_NAMES, NETWORKS } from './networks';
import { invalidRequest } from '../rpc/errors';
import { isContractId, sanitizeTokenMetadata } from '../stellar/token';

/**
 * Versioned snap state, stored encrypted via `snap_manageState`.
 * Never contains key material — keys are derived on demand and discarded.
 *
 * Schema history:
 *
 * | Version | Shape                                            | Status                   |
 * | ------- | ------------------------------------------------ | ------------------------ |
 * | 1       | `network`, `origins`, `tokens`                    | pre-release only         |
 * | 2       | adds `activeAccount`, `accounts` (multi-account)  | current                  |
 *
 * Version 1 was never published: the snap had no npm release before
 * multi-account landed, so the only stores holding it are development and
 * local-test installs. The migration therefore protects developer wallets,
 * not users, and may be dropped once the first audited release has shipped
 * and no pre-release install is worth preserving. It is kept for now because
 * removing it would silently reset those wallets' grants and tracked tokens.
 * Design rationale: docs/MULTI-ACCOUNT.md section 5.6.
 */
/** A tracked Soroban token (contract), scoped to a network. */
export type TrackedToken = {
  contractId: string;
  symbol: string;
  decimals: number;
};

/**
 * Cap on tracked tokens per network: every tracked token adds a simulation
 * round-trip to `getBalances` and each home-page render. Tokens can be
 * removed from the snap home page, so the cap is housekeeping, not a wall.
 */
export const MAX_TRACKED_TOKENS = 30;

/**
 * Upper bound (exclusive) on SEP-0005 account indices. Derivation cost is
 * trivial, so this is not a resource cap: it bounds what a corrupt or
 * hostile state value could ever drive into key derivation, and it is
 * comfortably above real multi-account usage.
 */
export const MAX_ACCOUNT_INDEX = 256;

/**
 * A SEP-0005 account index (`x` in `m/44'/148'/x'`): a non-negative integer
 * below {@link MAX_ACCOUNT_INDEX}. Shared by the state schema and the
 * `setActiveAccount` RPC params.
 */
export const AccountIndexStruct = refine(number(), 'AccountIndex', (value) =>
  Number.isInteger(value) && value >= 0 && value < MAX_ACCOUNT_INDEX
    ? true
    : `Expected an integer account index between 0 and ${MAX_ACCOUNT_INDEX - 1}.`,
);

/**
 * The disclosure the user must have seen for a grant to carry its full
 * capability set.
 *
 * Bump this whenever a connection grant starts to permit something the
 * previous consent dialog did not describe. Grants recorded under an older
 * disclosure keep working for what was disclosed at the time, and the newly
 * disclosed capability stays refused until the user re-consents.
 *
 * Version 1 is the disclosure that a connected site can enumerate every
 * revealed account, and therefore link them to each other. Grants predating
 * it (including every grant migrated from state version 1) carry no version
 * and cannot enumerate accounts until `requestAccess` is approved again.
 */
export const CURRENT_DISCLOSURE_VERSION = 1;

/**
 * Cap on recorded connection grants.
 *
 * The registry grows on its own, not only when the user connects a site
 * deliberately: an approved signature also records a grant, so a wallet used
 * across many sites accumulates entries monotonically, and nothing removes one
 * except a manual disconnect on the home page. Every `getState()` decrypts the
 * whole store, and the home page renders every entry, so unbounded growth
 * taxes each of those and degrades the one revocation UI the user has.
 *
 * Pruning drops the least recently connected grant. That is the safe direction:
 * a dropped grant only means the origin sees `getAddress() === ''` and must
 * call `requestAccess` again, which re-consents explicitly. Unlike token
 * pruning it is user-visible, which is why the cap sits far above the number of
 * sites any wallet realistically connects to.
 */
export const MAX_TRACKED_GRANTS = 100;

/**
 * Cap on the length of a stored origin key. MetaMask supplies real URL
 * origins, which are far shorter, so this only bounds what a corrupt store
 * could carry into the home page and the grant lookups.
 */
const MAX_ORIGIN_KEY_LENGTH = 2048;

/** A recorded connection grant. */
export type OriginGrant = {
  connectedAt: string;
  /**
   * The disclosure version the user approved. Absent on grants recorded
   * before disclosure versioning existed.
   */
  disclosureVersion?: number;
};

export type SnapState = {
  version: 2;
  /** The active network. Defaults to TESTNET until mainnet UX hardens. */
  network: NetworkName;
  /** The SEP-0005 index of the active account. Always in `accounts`. */
  activeAccount: number;
  /**
   * The account indices the user has revealed, always including 0. An
   * explicit registry (rather than derive-on-demand) bounds which addresses
   * the wallet will ever act for: an origin can select among these via the
   * SEP-43 `address` option, never an arbitrary never-revealed index.
   */
  accounts: number[];
  /** Origins the user has approved, with the grant timestamp. */
  origins: Record<string, OriginGrant>;
  /** Soroban tokens the user has added, keyed by network. */
  tokens?: Partial<Record<NetworkName, TrackedToken[]>>;
  /**
   * Which secret recovery phrase this store's key-derived contents belong to:
   * a SHA-256 of the `m/44'/148'` parent node's public key.
   *
   * The account registry and the connection grants both describe a specific
   * key set. `snap_getBip32Entropy` is called without a `source`, so it always
   * resolves the *primary* entropy source, and MetaMask supports more than one
   * secret recovery phrase. Nothing in the store previously recorded which one
   * produced it, so a change of primary phrase would silently reinterpret
   * "account 3" and every recorded grant against an unrelated key set.
   *
   * Absent on stores written before this field existed; recorded on first key
   * use (see `reconcileEntropyBinding` in `src/keys/index.ts`). It holds a hash
   * of a public key, never key material.
   */
  entropyFingerprint?: string;
};

/**
 * A persisted grant. `disclosureVersion` is optional so grants written before
 * disclosure versioning still validate rather than resetting the whole store.
 */
const GrantStruct = object({
  connectedAt: string(),
  disclosureVersion: optional(number()),
});

/** Structural schema for persisted state — see {@link parseState}. */
const SnapStateStruct = object({
  version: literal(2),
  network: enums(NETWORK_NAMES),
  activeAccount: AccountIndexStruct,
  accounts: size(array(AccountIndexStruct), 1, MAX_ACCOUNT_INDEX),
  origins: record(string(), GrantStruct),
  tokens: optional(
    record(
      enums(NETWORK_NAMES),
      array(
        object({ contractId: string(), symbol: string(), decimals: number() }),
      ),
    ),
  ),
  entropyFingerprint: optional(string()),
});

/**
 * Structural schema for legacy version-1 state (pre-release; see the schema
 * history above), kept so a pre-multi-account wallet migrates in place
 * instead of resetting (which would drop its connection grants and tracked
 * tokens). Exact-match by design: a version-1 object carrying any other key,
 * including version-2 account fields, matches neither schema and resets.
 */
const SnapStateV1Struct = object({
  version: literal(1),
  network: enums(NETWORK_NAMES),
  origins: record(string(), GrantStruct),
  tokens: optional(
    record(
      enums(NETWORK_NAMES),
      array(
        object({ contractId: string(), symbol: string(), decimals: number() }),
      ),
    ),
  ),
});

/**
 * Builds a fresh default state.
 *
 * @returns The default state object.
 */
function defaultState(): SnapState {
  return {
    version: 2,
    network: 'TESTNET',
    activeAccount: 0,
    accounts: [0],
    origins: {},
    tokens: {},
  };
}

/**
 * Normalizes the account fields of a structurally valid state: the account
 * set is deduplicated, sorted, and always contains index 0, and a stray
 * `activeAccount` that is not a member coerces back to 0 rather than being
 * trusted into derivation and display paths.
 *
 * @param state - A structurally valid version-2 state.
 * @returns The state with canonical account fields.
 */
function normalizeAccounts(state: SnapState): SnapState {
  const accounts = [...new Set([0, ...state.accounts])].sort(
    (left, right) => left - right,
  );
  const activeAccount = accounts.includes(state.activeAccount)
    ? state.activeAccount
    : 0;
  return { ...state, accounts, activeAccount };
}

/**
 * Normalizes persisted token registries at the parse boundary. The structural
 * schema deliberately stays permissive (a stricter schema would reset the
 * whole store, dropping grants), so the work bound is enforced here instead:
 * every network's array is capped at {@link MAX_TRACKED_TOKENS}, and entries
 * with an invalid contract ID, out-of-bounds metadata, or a duplicate
 * contract ID are dropped. `getBalances` and the home page fan out one
 * simulation per entry, so corrupt or legacy state must never carry more
 * entries — or stranger entries — than `addToken` could have written.
 *
 * @param tokens - The raw (structurally valid) tokens field.
 * @returns The normalized tokens field.
 */
function normalizeTokens(
  tokens: SnapState['tokens'],
): Partial<Record<NetworkName, TrackedToken[]>> {
  if (!tokens) {
    return {};
  }
  const normalized: Partial<Record<NetworkName, TrackedToken[]>> = {};
  for (const network of NETWORK_NAMES) {
    const entries = tokens[network];
    if (!entries) {
      continue;
    }
    const seen = new Set<string>();
    const kept: TrackedToken[] = [];
    for (const entry of entries) {
      if (kept.length >= MAX_TRACKED_TOKENS) {
        break;
      }
      if (!isContractId(entry.contractId) || seen.has(entry.contractId)) {
        continue;
      }
      const metadata = sanitizeTokenMetadata(entry.symbol, entry.decimals);
      if (!metadata) {
        continue;
      }
      seen.add(entry.contractId);
      kept.push({ contractId: entry.contractId, ...metadata });
    }
    // Only networks that actually carry tokens get a key. Writing an empty
    // array for every known network grew the store on each parse and made
    // "no tokens here" and "never had tokens here" indistinguishable; every
    // reader already treats a missing key as empty (`tokens?.[network] ?? []`).
    if (kept.length > 0) {
      normalized[network] = kept;
    }
  }
  return normalized;
}

/**
 * Normalizes the grant registry at the parse boundary, mirroring
 * {@link normalizeTokens}.
 *
 * The structural schema stays permissive on purpose: bounding the registry
 * there would make an oversized store fail validation and reset *everything*,
 * dropping the account registry along with the grants. So the bound is applied
 * here instead, where an over-cap store loses only its oldest grants. Keys that
 * would touch the prototype chain, or that are implausibly long, are dropped
 * rather than carried into the home page and the grant lookups.
 *
 * @param origins - The raw (structurally valid) origins map.
 * @returns The normalized origins map.
 */
function normalizeOrigins(origins: SnapState['origins']): SnapState['origins'] {
  const entries = Object.entries(origins).filter(
    ([origin]) =>
      isSafeStateKey(origin) && origin.length <= MAX_ORIGIN_KEY_LENGTH,
  );
  if (entries.length <= MAX_TRACKED_GRANTS) {
    return Object.fromEntries(entries);
  }
  // Most recently connected first, so the cap drops the stalest grants. ISO
  // timestamps sort lexicographically, and an unparseable one sorts last,
  // which is the right side of the cut for a value that cannot be trusted.
  entries.sort(([, left], [, right]) =>
    right.connectedAt.localeCompare(left.connectedAt),
  );
  return Object.fromEntries(entries.slice(0, MAX_TRACKED_GRANTS));
}

/**
 * Validates raw stored state. The snap is the only writer, but the store can
 * still surprise: a downgrade after a future version bump, or corruption.
 * A valid version-1 object migrates in place (accounts default to `[0]`,
 * preserving grants and tokens); anything matching neither schema resets to
 * defaults rather than flowing unchecked into signing and display paths.
 *
 * @param stored - The raw value from `snap_manageState`.
 * @returns The validated state, or a fresh default state.
 */
export function parseState(stored: unknown): SnapState {
  if (is(stored, SnapStateStruct)) {
    const state = stored as SnapState;
    return normalizeAccounts({
      ...state,
      origins: normalizeOrigins(state.origins),
      tokens: normalizeTokens(state.tokens),
    });
  }
  if (is(stored, SnapStateV1Struct)) {
    const legacy = stored as Omit<
      SnapState,
      'version' | 'activeAccount' | 'accounts'
    > & { version: 1 };
    return {
      ...legacy,
      version: 2,
      activeAccount: 0,
      accounts: [0],
      origins: normalizeOrigins(legacy.origins),
      tokens: normalizeTokens(legacy.tokens),
    };
  }
  return defaultState();
}

/**
 * Reads the snap state, falling back to defaults when unset.
 *
 * @returns The current state.
 */
export async function getState(): Promise<SnapState> {
  const stored = await snap.request({
    method: 'snap_manageState',
    // `encrypted` is explicit, not left to the SDK default. The default is
    // `true` today, but this store holds the user's connection grants and
    // revealed account set: linkage data whose storage tier must not be able
    // to change under a dependency bump, or be lost when one of these call
    // sites is copied into a context expecting the unencrypted store.
    params: { operation: 'get', encrypted: true },
  });
  if (!stored) {
    return defaultState();
  }
  return parseState(stored);
}

/**
 * Persists the snap state.
 *
 * @param state - The state to store.
 */
export async function saveState(state: SnapState): Promise<void> {
  await snap.request({
    method: 'snap_manageState',
    // Explicit for the reason given in `getState`: the read and the write must
    // never disagree about which store they address.
    params: { operation: 'update', encrypted: true, newState: state },
  });
}

/**
 * Serializes state mutations. `snap_manageState` offers no compare-and-swap,
 * so two concurrent read-modify-write sequences could interleave between
 * their get and update and silently drop one writer's change. Every mutation
 * helper below runs its whole get-modify-update body under this promise-chain
 * mutex, so mutations execute strictly one after another.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

/**
 * Runs a state mutation exclusively: it starts only after every previously
 * queued mutation has settled, and later mutations wait for it in turn.
 *
 * @param fn - The mutation body (a full get-modify-update sequence).
 * @returns The mutation's result.
 */
async function withStateLock<Type>(fn: () => Promise<Type>): Promise<Type> {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Resolves the active network configuration.
 *
 * @returns The active network's config.
 */
export async function getActiveNetwork(): Promise<NetworkConfig> {
  const state = await getState();
  return NETWORKS[state.network];
}

/**
 * Switches the active network via a locked read-modify-write. The state is
 * re-read inside the lock, so a stale snapshot captured before a
 * confirmation dialog can never clobber grants or tokens added while the
 * dialog was open.
 *
 * @param network - The network to activate.
 */
export async function setActiveNetwork(network: NetworkName): Promise<void> {
  await withStateLock(async () => {
    const state = await getState();
    if (state.network !== network) {
      await saveState({ ...state, network });
    }
  });
}

/**
 * The next account index the home-page "Add account" flow may reveal: always
 * the next contiguous index after the highest revealed one, so the account
 * set stays gap-free and portable with other SEP-0005 wallets.
 *
 * @param state - The current state.
 * @returns The next revealable index.
 */
export function nextAccountIndex(state: SnapState): number {
  return Math.max(...state.accounts) + 1;
}

/**
 * Reveals (appends) an account index via a locked read-modify-write. Only
 * the next contiguous index may be revealed; the caller derives and shows
 * the address for that index in a confirmation dialog first, so the commit
 * re-checks under the lock that the set has not moved meanwhile — a stale
 * approval must never add a different account than the one displayed.
 *
 * @param index - The index the user approved (must still be the next one).
 */
export async function revealAccount(index: number): Promise<void> {
  await withStateLock(async () => {
    const state = await getState();
    if (state.accounts.includes(index)) {
      return;
    }
    if (index >= MAX_ACCOUNT_INDEX) {
      throw invalidRequest(
        `Account limit reached: at most ${MAX_ACCOUNT_INDEX} accounts.`,
      );
    }
    if (index !== nextAccountIndex(state)) {
      throw invalidRequest(
        'The account list changed while the dialog was open. Try again.',
      );
    }
    await saveState({ ...state, accounts: [...state.accounts, index] });
  });
}

/**
 * Reveals every index up to and including `target` in one locked commit.
 *
 * Reaching an account the user already holds elsewhere previously meant
 * revealing one index per confirmation, so an account at index 40 cost 40
 * dialogs. This reveals the whole run at once while preserving the same
 * gap-free invariant {@link revealAccount} maintains: the set still grows
 * contiguously from 0, so it stays portable with other SEP-0005 wallets.
 *
 * @param target - The highest index to reveal.
 * @param expectedFrom - The next revealable index the caller showed in its
 * confirmation dialog. Re-checked here so a stale approval cannot commit a
 * different run of accounts than the one the user saw.
 * @returns The indices actually added, in ascending order.
 */
export async function revealAccountsThrough(
  target: number,
  expectedFrom: number,
): Promise<number[]> {
  return withStateLock(async () => {
    const state = await getState();
    if (!Number.isInteger(target) || target < 0) {
      throw invalidRequest('Invalid account index.');
    }
    if (target >= MAX_ACCOUNT_INDEX) {
      throw invalidRequest(
        `Account limit reached: at most ${MAX_ACCOUNT_INDEX} accounts.`,
      );
    }
    const next = nextAccountIndex(state);
    if (target < next) {
      // Already revealed, by this call or by a concurrent one. The user's
      // goal is satisfied either way, so this is a no-op rather than an
      // error.
      return [];
    }
    if (next !== expectedFrom) {
      throw invalidRequest(
        'The account list changed while the dialog was open. Try again.',
      );
    }
    const added: number[] = [];
    for (let index = next; index <= target; index += 1) {
      added.push(index);
    }
    await saveState({ ...state, accounts: [...state.accounts, ...added] });
    return added;
  });
}

/**
 * Switches the active account via a locked read-modify-write, mirroring
 * {@link setActiveNetwork}. Membership is re-checked inside the lock: a
 * stale pre-dialog snapshot can never activate an index that is no longer
 * (or was never) revealed.
 *
 * @param index - The revealed account index to activate.
 */
export async function setActiveAccount(index: number): Promise<void> {
  await withStateLock(async () => {
    const state = await getState();
    if (!state.accounts.includes(index)) {
      throw invalidRequest('Unknown account index.');
    }
    if (state.activeAccount !== index) {
      await saveState({ ...state, activeAccount: index });
    }
  });
}

/**
 * Object keys that resolve to inherited properties.
 * MetaMask supplies real URL origins, so
 * these never occur in practice — the guard is defense in depth.
 */
const FORBIDDEN_STATE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Whether a string is safe to use as a state-object key.
 *
 * @param key - The candidate key (an origin).
 * @returns False for keys that would touch the prototype chain.
 */
export function isSafeStateKey(key: string): boolean {
  return !FORBIDDEN_STATE_KEYS.has(key);
}

/**
 * Whether `origins` holds an own grant for this origin. Uses `hasOwnProperty`
 * (not `origins[origin]`) so a crafted origin such as `__proto__` cannot
 * report a phantom grant via the prototype chain.
 *
 * @param origins - The origins map from state.
 * @param origin - The dapp origin.
 * @returns True when an own grant exists.
 */
export function originHasGrant(
  origins: SnapState['origins'],
  origin: string,
): boolean {
  return (
    isSafeStateKey(origin) &&
    Object.prototype.hasOwnProperty.call(origins, origin)
  );
}

/**
 * Whether the origin has a standing connection grant.
 *
 * @param origin - The dapp origin.
 * @returns True when the origin was previously approved by the user.
 */
export async function isOriginConnected(origin: string): Promise<boolean> {
  const state = await getState();
  return originHasGrant(state.origins, origin);
}

/**
 * Whether the origin's grant was approved under the current disclosure.
 *
 * A grant recorded before a capability was disclosed must not silently gain
 * that capability when the snap updates: the user consented to what the
 * dialog said at the time, not to what it says now.
 *
 * @param origins - The origins map from state.
 * @param origin - The dapp origin.
 * @returns True when the grant carries the current disclosure version.
 */
export function grantHasCurrentDisclosure(
  origins: SnapState['origins'],
  origin: string,
): boolean {
  if (!originHasGrant(origins, origin)) {
    return false;
  }
  return origins[origin]?.disclosureVersion === CURRENT_DISCLOSURE_VERSION;
}

/**
 * Whether the origin may use capabilities introduced by the current
 * disclosure (today: enumerating every revealed account).
 *
 * @param origin - The dapp origin.
 * @returns True when the user approved the current disclosure.
 */
export async function hasCurrentDisclosure(origin: string): Promise<boolean> {
  const state = await getState();
  return grantHasCurrentDisclosure(state.origins, origin);
}

/**
 * Records a connection grant for the origin, stamped with the disclosure the
 * user has just seen.
 *
 * Idempotent for a grant already at the current disclosure; a grant recorded
 * under an older disclosure is upgraded in place, which is what re-approving
 * the connect dialog is for.
 *
 * @param origin - The dapp origin the user approved.
 */
export async function connectOrigin(origin: string): Promise<void> {
  if (!isSafeStateKey(origin)) {
    return;
  }
  await withStateLock(async () => {
    const state = await getState();
    if (grantHasCurrentDisclosure(state.origins, origin)) {
      return;
    }
    const existing = originHasGrant(state.origins, origin)
      ? state.origins[origin]
      : undefined;
    const origins = { ...state.origins };
    origins[origin] = {
      // An upgraded grant keeps the original connection time; only the
      // disclosure it was approved under changes.
      connectedAt: existing?.connectedAt ?? new Date().toISOString(),
      disclosureVersion: CURRENT_DISCLOSURE_VERSION,
    };
    // Enforce the cap at the write that causes growth, not only at the parse
    // boundary, so the store never holds more than the cap even transiently.
    // `normalizeOrigins` keeps the most recently connected, and the grant just
    // written carries the newest timestamp, so it is never the one dropped.
    await saveState({ ...state, origins: normalizeOrigins(origins) });
  });
}

/**
 * Binds the store to the secret recovery phrase its key-derived contents were
 * built from, resetting those contents when the phrase has changed.
 *
 * Called from the key layer, which is the only place that can compute the
 * fingerprint. A store with no fingerprint recorded simply adopts the current
 * one: that is the upgrade path for wallets written before this field existed,
 * and it assumes continuity, which is correct because a vault restored from a
 * different phrase does not carry the old snap state forward anyway.
 *
 * A *mismatch* is different: the account registry and the grants describe key
 * material this wallet no longer has. Account indices would name unrelated
 * addresses, and a grant would extend consent given for one wallet to another.
 * Both are reset. The network preference and the tracked-token registry are
 * kept, since neither is derived from the phrase. The check cannot false
 * positive: the fingerprint is a deterministic function of the phrase.
 *
 * @param fingerprint - The current entropy fingerprint.
 * @returns True when a mismatch was found and the store was reset.
 */
export async function reconcileEntropyBinding(
  fingerprint: string,
): Promise<boolean> {
  return withStateLock(async () => {
    const state = await getState();
    if (state.entropyFingerprint === fingerprint) {
      return false;
    }
    if (state.entropyFingerprint === undefined) {
      await saveState({ ...state, entropyFingerprint: fingerprint });
      return false;
    }
    await saveState({
      ...defaultState(),
      network: state.network,
      tokens: state.tokens ?? {},
      entropyFingerprint: fingerprint,
    });
    return true;
  });
}

/**
 * Removes a tracked token from a network's registry (idempotent).
 *
 * @param network - The network name.
 * @param contractId - The token contract to stop tracking.
 */
export async function removeToken(
  network: NetworkName,
  contractId: string,
): Promise<void> {
  await withStateLock(async () => {
    const state = await getState();
    const forNetwork = state.tokens?.[network] ?? [];
    const remaining = forNetwork.filter(
      (entry) => entry.contractId !== contractId,
    );
    if (remaining.length !== forNetwork.length) {
      await saveState({
        ...state,
        tokens: { ...state.tokens, [network]: remaining },
      });
    }
  });
}

/**
 * Removes an origin's connection grant (idempotent).
 *
 * @param origin - The dapp origin to disconnect.
 */
export async function disconnectOrigin(origin: string): Promise<void> {
  await withStateLock(async () => {
    const state = await getState();
    if (!originHasGrant(state.origins, origin)) {
      return;
    }
    const origins = { ...state.origins };
    delete origins[origin];
    await saveState({ ...state, origins });
  });
}

/**
 * Lists the tokens tracked on a given network.
 *
 * @param network - The network name.
 * @returns The tracked tokens (empty when none).
 */
export async function getTokens(network: NetworkName): Promise<TrackedToken[]> {
  const state = await getState();
  return state.tokens?.[network] ?? [];
}

/**
 * Adds a token to a network's registry (idempotent by contract ID).
 * The {@link MAX_TRACKED_TOKENS} cap is re-checked here at commit time,
 * inside the lock: the caller's pre-dialog check reads a snapshot that can
 * go stale while the confirmation dialog is open.
 *
 * @param network - The network name.
 * @param token - The token to add.
 * @returns True when newly added, false when already present.
 * @throws An invalid-request error when the cap is already reached.
 */
export async function addToken(
  network: NetworkName,
  token: TrackedToken,
): Promise<boolean> {
  return withStateLock(async () => {
    const state = await getState();
    const tokens = state.tokens ?? {};
    const forNetwork = tokens[network] ?? [];
    if (forNetwork.some((entry) => entry.contractId === token.contractId)) {
      return false;
    }
    if (forNetwork.length >= MAX_TRACKED_TOKENS) {
      throw invalidRequest(
        `Token limit reached: at most ${MAX_TRACKED_TOKENS} tracked tokens per network.`,
      );
    }
    tokens[network] = [...forNetwork, token];
    await saveState({ ...state, tokens });
    return true;
  });
}
