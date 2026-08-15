import { getWalletAddress } from '../keys';
import { userRejected } from '../rpc/errors';
import { clearDialogRejections, recordDialogOpened } from '../rpc/throttle';
import {
  connectOrigin,
  getState,
  hasCurrentDisclosure,
  isOriginConnected,
} from '../state';
import { ConnectDialog } from '../ui/dialogs';

/**
 * `requestAccess` — SEP-43 entry point. Shows a connect dialog on first use;
 * silently returns the address for already-granted origins.
 *
 * A grant recorded under an older disclosure is treated as needing consent
 * again, so the dialog is shown rather than skipped. That is what lets an
 * origin regain a capability the snap has since started disclosing (today:
 * account enumeration) without ever granting it silently on update.
 *
 * @param origin - The requesting dapp origin.
 * @returns The wallet address.
 */
export async function requestAccess(
  origin: string,
): Promise<{ address: string }> {
  const address = await getWalletAddress();

  if (await hasCurrentDisclosure(origin)) {
    return { address };
  }

  const state = await getState();
  recordDialogOpened(origin);
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
  // An approved dialog breaks the consecutive-rejection chain. Cleared here,
  // not on handler success: the silent already-granted path above must not
  // reset the count.
  clearDialogRejections(origin);

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
