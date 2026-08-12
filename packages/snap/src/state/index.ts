import {
  array,
  enums,
  is,
  literal,
  number,
  object,
  optional,
  record,
  string,
} from '@metamask/superstruct';

import type { NetworkConfig, NetworkName } from './networks';
import { NETWORK_NAMES, NETWORKS } from './networks';
import { invalidRequest } from '../rpc/errors';

/**
 * Versioned snap state, stored encrypted via `snap_manageState`.
 * Never contains key material — keys are derived on demand and discarded.
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

export type SnapState = {
  version: 1;
  /** The active network. Defaults to TESTNET until mainnet UX hardens. */
  network: NetworkName;
  /** Origins the user has approved, with the grant timestamp. */
  origins: Record<string, { connectedAt: string }>;
  /** Soroban tokens the user has added, keyed by network. */
  tokens?: Partial<Record<NetworkName, TrackedToken[]>>;
};

/** Structural schema for persisted state — see {@link parseState}. */
const SnapStateStruct = object({
  version: literal(1),
  network: enums(NETWORK_NAMES),
  origins: record(string(), object({ connectedAt: string() })),
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
  return { version: 1, network: 'TESTNET', origins: {}, tokens: {} };
}

/**
 * Validates raw stored state. The snap is the only writer, but the store can
 * still surprise: a downgrade after a future version bump, or corruption.
 * Anything that does not match the version-1 schema resets to defaults
 * rather than flowing unchecked into signing and display paths.
 *
 * @param stored - The raw value from `snap_manageState`.
 * @returns The validated state, or a fresh default state.
 */
export function parseState(stored: unknown): SnapState {
  return is(stored, SnapStateStruct) ? (stored as SnapState) : defaultState();
}

/**
 * Reads the snap state, falling back to defaults when unset.
 *
 * @returns The current state.
 */
export async function getState(): Promise<SnapState> {
  const stored = await snap.request({
    method: 'snap_manageState',
    params: { operation: 'get' },
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
    params: { operation: 'update', newState: state },
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
 * Records a connection grant for the origin (idempotent).
 *
 * @param origin - The dapp origin the user approved.
 */
export async function connectOrigin(origin: string): Promise<void> {
  if (!isSafeStateKey(origin)) {
    return;
  }
  await withStateLock(async () => {
    const state = await getState();
    if (!originHasGrant(state.origins, origin)) {
      state.origins[origin] = { connectedAt: new Date().toISOString() };
      await saveState(state);
    }
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
