import { assertConnected } from './account';
import {
  assertBindingCurrent,
  getAddressForIndex,
  getOwnedAccounts,
} from '../keys';
import { invalidRequest, userRejected } from '../rpc/errors';
import { clearDialogRejections, recordDialogOpened } from '../rpc/throttle';
import { SetActiveAccountParams, validate } from '../rpc/validation';
import {
  grantHasCurrentDisclosure,
  setActiveAccount as setActiveAccountState,
} from '../state';
import { SwitchAccountDialog } from '../ui/dialogs';

/** A revealed account as returned to dapps. */
export type AccountInfo = { index: number; address: string };

/**
 * `getAccounts` — enumerate the revealed accounts (the method SEP-43 lacks).
 * Read-only and dialog-free, but reserved for connected origins: it
 * discloses every revealed address at once (which links them), so it must
 * not offer a fingerprinting surface beyond what a connected origin already
 * has via `getAddress`.
 *
 * Everything it discloses comes from the binding the grant check produced:
 * the registry is the binding's snapshot and the addresses are derived under
 * the binding's phrase, so a phrase change overlapping the request cannot
 * turn a grant for the previous wallet into an enumeration of the new one.
 *
 * @param origin - The requesting dapp origin.
 * @returns The revealed accounts and the active index.
 */
export async function getAccounts(
  origin: string,
): Promise<{ accounts: AccountInfo[]; activeIndex: number }> {
  const binding = await assertConnected(origin);
  // Enumeration is only permitted under the disclosure that describes it. A
  // grant predating that disclosure (including any migrated from state
  // version 1) must be re-approved first, so the capability is never acquired
  // silently by updating the snap.
  if (!grantHasCurrentDisclosure(binding.state.origins, origin)) {
    throw invalidRequest(
      'This site was connected before account enumeration was disclosed. ' +
        'Call requestAccess to re-confirm the connection first.',
    );
  }
  const accounts = await getOwnedAccounts(binding);
  assertBindingCurrent(binding);
  return { accounts, activeIndex: binding.state.activeAccount };
}

/**
 * `setActiveAccount` — dialog-confirmed switch of the active account,
 * mirroring `setNetwork`: wallet-global, reserved for connected origins,
 * committed under the state lock so a stale pre-dialog snapshot cannot
 * clobber concurrent changes. Only revealed accounts can be activated; a
 * dapp cannot use this to make the wallet derive a new index.
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ index }`, a revealed SEP-0005 account index.
 * @returns The new active account.
 */
export async function setActiveAccount(
  origin: string,
  params: unknown,
): Promise<AccountInfo> {
  const binding = await assertConnected(origin);
  const { index } = validate(params, SetActiveAccountParams);
  const { state } = binding;

  if (!state.accounts.includes(index)) {
    throw invalidRequest(
      'Unknown account index: the user has not added it. Accounts are added from the snap home page.',
    );
  }

  const address = await getAddressForIndex(binding, index);
  if (state.activeAccount !== index) {
    recordDialogOpened(origin);
    const approved = await snap.request({
      method: 'snap_dialog',
      params: {
        type: 'confirmation',
        content: (
          <SwitchAccountDialog
            origin={origin}
            fromIndex={state.activeAccount}
            toIndex={index}
            toAddress={address}
          />
        ),
      },
    });
    if (!approved) {
      throw userRejected();
    }
    // An approved dialog breaks the consecutive-rejection chain. Cleared
    // here, not on handler success: the no-dialog path (index already
    // active) must not reset the count.
    clearDialogRejections(origin);
    // Re-read and commit under the state lock; membership is re-checked
    // there against the post-dialog state, and the fingerprint against the
    // phrase the displayed address was derived under.
    await setActiveAccountState(index, binding.fingerprint);
  }

  return { index, address };
}
