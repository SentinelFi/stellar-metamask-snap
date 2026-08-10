import { getWalletAddress } from '../keys';
import { userRejected } from '../rpc/errors';
import { connectOrigin, getState, isOriginConnected } from '../state';
import { ConnectDialog } from '../ui/dialogs';

/**
 * `requestAccess` — SEP-43 entry point. Shows a connect dialog on first use;
 * silently returns the address for already-granted origins.
 *
 * @param origin - The requesting dapp origin.
 * @returns The wallet address.
 */
export async function requestAccess(
  origin: string,
): Promise<{ address: string }> {
  const address = await getWalletAddress();

  if (await isOriginConnected(origin)) {
    return { address };
  }

  const state = await getState();
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <ConnectDialog
          origin={origin}
          address={address}
          network={state.network}
        />
      ),
    },
  });

  if (!approved) {
    throw userRejected();
  }

  await connectOrigin(origin);
  return { address };
}

/**
 * `getAddress` — Freighter semantics: silent, and returns an empty string
 * when the origin has no standing grant (no dialog, no fingerprinting).
 *
 * @param origin - The requesting dapp origin.
 * @returns The wallet address, or an empty string when not connected.
 */
export async function getAddress(origin: string): Promise<{ address: string }> {
  if (!(await isOriginConnected(origin))) {
    return { address: '' };
  }
  return { address: await getWalletAddress() };
}
