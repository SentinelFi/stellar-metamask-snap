import { assertConnected } from './account';
import { userRejected } from '../rpc/errors';
import { clearDialogRejections, recordDialogOpened } from '../rpc/throttle';
import { SetNetworkParams, validate } from '../rpc/validation';
import { getActiveNetwork, getState, setActiveNetwork } from '../state';
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
 * `setNetwork`: dialog-confirmed switch between known networks. The switch
 * is wallet-global, so it is reserved for origins the user has already
 * connected: an unknown origin gets the standard not-connected error
 * instead of a confirmation dialog.
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ network: 'PUBLIC' | 'TESTNET' | 'FUTURENET' }`.
 * @returns The new network details.
 */
export async function setNetwork(
  origin: string,
  params: unknown,
): Promise<NetworkDetails> {
  await assertConnected(origin);
  const { network: target } = validate(params, SetNetworkParams);
  const state = await getState();

  if (state.network !== target) {
    recordDialogOpened(origin);
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
    // An approved dialog breaks the consecutive-rejection chain. Cleared
    // here, not on handler success: the no-dialog path (target already
    // active) must not reset the count.
    clearDialogRejections(origin);
    // Re-read and write under the state lock: the pre-dialog snapshot may
    // be stale by the time the user approves.
    await setActiveNetwork(target);
  }

  const network = NETWORKS[target];
  return {
    network: network.name,
    networkPassphrase: network.networkPassphrase,
    networkUrl: network.horizonUrl,
    sorobanRpcUrl: network.sorobanRpcUrl,
  };
}
