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
 * Resolves the active network configuration.
 *
 * @returns The active network's config.
 */
export async function getActiveNetwork(): Promise<NetworkConfig> {
  const state = await getState();
  return NETWORKS[state.network];
}

/**
 * Whether the origin has a standing connection grant.
 *
 * @param origin - The dapp origin.
 * @returns True when the origin was previously approved by the user.
 */
export async function isOriginConnected(origin: string): Promise<boolean> {
  const state = await getState();
  return Boolean(state.origins[origin]);
}

/**
 * Records a connection grant for the origin (idempotent).
 *
 * @param origin - The dapp origin the user approved.
 */
export async function connectOrigin(origin: string): Promise<void> {
  const state = await getState();
  if (!state.origins[origin]) {
    state.origins[origin] = { connectedAt: new Date().toISOString() };
    await saveState(state);
  }
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
}

/**
 * Removes an origin's connection grant (idempotent).
 *
 * @param origin - The dapp origin to disconnect.
 */
export async function disconnectOrigin(origin: string): Promise<void> {
  const state = await getState();
  if (!state.origins[origin]) {
    return;
  }
  const origins = { ...state.origins };
  delete origins[origin];
  await saveState({ ...state, origins });
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
 *
 * @param network - The network name.
 * @param token - The token to add.
 * @returns True when newly added, false when already present.
 */
export async function addToken(
  network: NetworkName,
  token: TrackedToken,
): Promise<boolean> {
  const state = await getState();
  const tokens = state.tokens ?? {};
  const forNetwork = tokens[network] ?? [];
  if (forNetwork.some((entry) => entry.contractId === token.contractId)) {
    return false;
  }
  tokens[network] = [...forNetwork, token];
  await saveState({ ...state, tokens });
  return true;
}
