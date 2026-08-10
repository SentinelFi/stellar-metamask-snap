import type { NetworkConfig, NetworkName } from './networks';
import { NETWORKS } from './networks';

/**
 * Versioned snap state, stored encrypted via `snap_manageState`.
 * Never contains key material — keys are derived on demand and discarded.
 */
export type SnapState = {
  version: 1;
  /** The active network. Defaults to TESTNET until mainnet UX hardens. */
  network: NetworkName;
  /** Origins the user has approved, with the grant timestamp. */
  origins: Record<string, { connectedAt: string }>;
};

/**
 * Builds a fresh default state.
 *
 * @returns The default state object.
 */
function defaultState(): SnapState {
  return { version: 1, network: 'TESTNET', origins: {} };
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
  // The snap is the only writer; `version` gates future migrations.
  return stored as unknown as SnapState;
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
