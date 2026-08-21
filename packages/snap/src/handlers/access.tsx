import { ensureEntropyBinding, getWalletAddress } from '../keys';
import { externalServiceError, userRejected } from '../rpc/errors';
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
  // Before the disclosure check below, not merely before the dialog: that check
  // reads a stored grant, and a grant recorded under a different secret
  // recovery phrase must be cleared before it can be honoured. The address
  // lookup that follows is a cache hit, since this derives the active account.
  //
  // The fingerprint is kept for the grant write at the end: it names the
  // wallet the dialog below is about, and `connectOrigin` compares it against
  // the store before recording anything, so an approval given while this
  // phrase was active cannot create a grant for a phrase that replaced it
  // while the dialog was open.
  const entropyFingerprint = await ensureEntropyBinding();
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

  const granted = await connectOrigin(origin, entropyFingerprint);
  if (!granted) {
    // The primary secret recovery phrase changed while the dialog was open:
    // the consent on screen described the previous wallet's address, so
    // neither a grant nor that address may be handed to the origin.
    throw externalServiceError(
      'The active secret recovery phrase changed while the connection ' +
        'request was in progress, so the approval no longer applies. Try ' +
        'again.',
    );
  }
  return { address };
}

/**
 * `getAddress` — Freighter semantics: silent, and returns an empty string
 * when the origin has no standing grant (no dialog, no fingerprinting).
 *
 * The grant is read on either side of the entropy binding, mirroring
 * `assertConnected`. This method is where the ordering mattered most: it used
 * to check the grant and only then derive, and deriving is what discovers a
 * changed secret recovery phrase and clears the grants recorded under the old
 * one. So the single call that revoked a grant would still answer it, handing
 * an origin an address for a wallet it had never been granted access to. The
 * second read observes the reconciliation and returns an empty string instead.
 *
 * The cheap first read is what keeps an origin with no grant from costing a key
 * derivation, preserving the property that an unconnected caller cannot drive
 * one from here.
 *
 * @param origin - The requesting dapp origin.
 * @returns The wallet address, or an empty string when not connected.
 */
export async function getAddress(origin: string): Promise<{ address: string }> {
  if (!(await isOriginConnected(origin))) {
    return { address: '' };
  }
  await ensureEntropyBinding();
  if (!(await isOriginConnected(origin))) {
    return { address: '' };
  }
  return { address: await getWalletAddress() };
}
