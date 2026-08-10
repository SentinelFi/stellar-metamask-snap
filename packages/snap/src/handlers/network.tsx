import { userRejected } from '../rpc/errors';
import { SetNetworkParams, validate } from '../rpc/validation';
import { getActiveNetwork, getState, saveState } from '../state';
import type { NetworkName } from '../state/networks';
import { NETWORKS } from '../state/networks';
import { NetworkDialog } from '../ui/dialogs';

export type NetworkDetails = {
  network: NetworkName;
  networkPassphrase: string;
  networkUrl: string;
  sorobanRpcUrl: string;
};

/**
 * `getNetwork` — SEP-43 shape.
 *
 * @returns The active network name and passphrase.
 */
export async function getNetwork(): Promise<{
  network: NetworkName;
  networkPassphrase: string;
}> {
  const network = await getActiveNetwork();
  return {
    network: network.name,
    networkPassphrase: network.networkPassphrase,
  };
}

/**
 * `getNetworkDetails` — Freighter-compatible extended shape.
 *
 * @returns Network name, passphrase, Horizon URL, and Soroban RPC URL.
 */
export async function getNetworkDetails(): Promise<NetworkDetails> {
  const network = await getActiveNetwork();
  return {
    network: network.name,
    networkPassphrase: network.networkPassphrase,
    networkUrl: network.horizonUrl,
    sorobanRpcUrl: network.sorobanRpcUrl,
  };
}

/**
 * `setNetwork` — dialog-confirmed switch between known networks.
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ network: 'PUBLIC' | 'TESTNET' | 'FUTURENET' }`.
 * @returns The new network details.
 */
export async function setNetwork(
  origin: string,
  params: unknown,
): Promise<NetworkDetails> {
  const { network: target } = validate(params, SetNetworkParams);
  const state = await getState();

  if (state.network !== target) {
    const approved = await snap.request({
      method: 'snap_dialog',
      params: {
        type: 'confirmation',
        content: (
          <NetworkDialog origin={origin} from={state.network} to={target} />
        ),
      },
    });
    if (!approved) {
      throw userRejected();
    }
    await saveState({ ...state, network: target });
  }

  const network = NETWORKS[target];
  return {
    network: network.name,
    networkPassphrase: network.networkPassphrase,
    networkUrl: network.horizonUrl,
    sorobanRpcUrl: network.sorobanRpcUrl,
  };
}
