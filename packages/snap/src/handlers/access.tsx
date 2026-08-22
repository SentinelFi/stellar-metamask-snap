import {
  assertPhraseUnchanged,
  ensureEntropyBinding,
  getActiveAddress,
} from '../keys';
import { externalServiceError, userRejected } from '../rpc/errors';
import { clearDialogRejections, recordDialogOpened } from '../rpc/throttle';
import {
  connectOrigin,
  grantHasCurrentDisclosure,
  isOriginConnected,
  originHasGrant,
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
  // recovery phrase must be cleared before it can be honoured. The grant is
  // read from the binding's own snapshot, which is known to belong to the
  // phrase the address below is derived under; the address lookup is a cache
  // hit, since the binding derives the active account.
  //
  // The binding is kept for the grant write at the end: its fingerprint names
  // the wallet the dialog below is about, and `connectOrigin` compares it
  // against the store before recording anything, so an approval given while
  // this phrase was active cannot create a grant for a phrase that replaced it
  // while the dialog was open.
  const binding = await ensureEntropyBinding();
  const address = await getActiveAddress(binding);

  if (grantHasCurrentDisclosure(binding.state.origins, origin)) {
    // Nothing is written on this path, but the address is still
    // wallet-derived data, so it is confirmed fresh before it is handed over:
    // an address answered after a switch nobody has observed describes a
    // wallet the user has stopped using, and the origin cannot tell.
    await assertPhraseUnchanged(binding);
    return { address };
  }

  recordDialogOpened(origin);
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <ConnectDialog
          origin={origin}
          address={address}
          network={binding.state.network}
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

  // The approval on screen described this phrase. Re-observe it before the
  // grant is written: a switch while the dialog was open leaves the persisted
  // fingerprint naming the old phrase, so the state-lock comparison below
  // would compare it against itself and admit the stale approval.
  await assertPhraseUnchanged(binding);

  const granted = await connectOrigin(origin, binding.fingerprint);
  if (!granted) {
    // The second line, and it refuses for either reason `connectOrigin` has:
    // a phrase that changed in the moment between the check above and the
    // write, or an origin whose name cannot be used as a state key. Neither
    // the grant nor the address may be handed over when no grant was
    // recorded, so the message does not claim a cause it cannot distinguish.
    throw externalServiceError(
      'The connection could not be recorded for this site, so the approval ' +
        'did not take effect. Try again.',
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
 * second read is of the binding's own snapshot, which observed the
 * reconciliation and belongs to the phrase the address is derived under, so
 * a grant from another phrase yields an empty string instead.
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
  const binding = await ensureEntropyBinding();
  if (!originHasGrant(binding.state.origins, origin)) {
    return { address: '' };
  }
  const address = await getActiveAddress(binding);
  await assertPhraseUnchanged(binding);
  return { address };
}
