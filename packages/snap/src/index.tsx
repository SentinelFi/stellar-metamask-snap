import type {
  OnHomePageHandler,
  OnInstallHandler,
  OnRpcRequestHandler,
  OnUserInputHandler,
} from '@metamask/snaps-sdk';
import { UserInputEventType } from '@metamask/snaps-sdk';
import { Box, Text } from '@metamask/snaps-sdk/jsx';

import {
  ADD_ACCOUNT_BUTTON,
  DISCONNECT_PREFIX,
  REMOVE_TOKEN_PREFIX,
  USE_ACCOUNT_PREFIX,
  homePage,
} from './handlers/home';
import { installWelcome } from './handlers/install';
import { getAddressForIndex } from './keys';
import { route } from './rpc/router';
import {
  disconnectOrigin,
  getState,
  MAX_ACCOUNT_INDEX,
  nextAccountIndex,
  removeToken,
  revealAccount,
  setActiveAccount,
} from './state';
import type { NetworkName } from './state/networks';
import { NETWORK_NAMES } from './state/networks';
import { AddAccountDialog } from './ui/dialogs';

/**
 * Handle incoming JSON-RPC requests sent through `wallet_invokeSnap`.
 *
 * The RPC surface follows SEP-0043 with Freighter-compatible semantics; see
 * docs/PHASE-1.md for the full method table and consent model.
 *
 * @param args - The request handler args.
 * @param args.origin - The origin of the request (provided by MetaMask).
 * @param args.request - A validated JSON-RPC request object.
 * @returns The result of the requested method.
 */
export const onRpcRequest: OnRpcRequestHandler = async ({ origin, request }) =>
  route(origin, request);

/**
 * The snap home page (MetaMask menu → Snaps → Stellar Soroban): active
 * network, wallet address, and balances.
 *
 * @returns The home page content.
 */
export const onHomePage: OnHomePageHandler = async () => homePage();

/**
 * One-time welcome dialog after installation.
 *
 * @returns Resolves when dismissed.
 */
export const onInstall: OnInstallHandler = async () => installWelcome();

/**
 * Reveals the next contiguous SEP-0005 account after a confirmation dialog
 * showing its index and address. The commit re-checks under the state lock
 * that the set has not moved while the dialog was open.
 *
 * @returns True when an account was added.
 */
async function addAccountFlow(): Promise<boolean> {
  const index = nextAccountIndex(await getState());
  if (index >= MAX_ACCOUNT_INDEX) {
    await snap.request({
      method: 'snap_dialog',
      params: {
        type: 'alert',
        content: (
          <Box>
            <Text>
              {`Account limit reached: at most ${MAX_ACCOUNT_INDEX} accounts.`}
            </Text>
          </Box>
        ),
      },
    });
    return false;
  }

  const address = await getAddressForIndex(index);
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: <AddAccountDialog index={index} address={address} />,
    },
  });
  if (!approved) {
    return false;
  }
  await revealAccount(index);
  return true;
}

/**
 * Handle home-page interactions: "Disconnect" buttons revoke an origin's
 * connection grant, "Remove" buttons stop tracking a token, "Use" buttons
 * switch the active account, and "Add account" reveals the next account
 * after a confirmation. Every action re-renders the page.
 *
 * @param args - The user input handler args.
 * @param args.id - The interface ID to update.
 * @param args.event - The user input event.
 */
export const onUserInput: OnUserInputHandler = async ({ id, event }) => {
  if (event.type !== UserInputEventType.ButtonClickEvent || !event.name) {
    return;
  }

  let changed = false;
  if (event.name.startsWith(DISCONNECT_PREFIX)) {
    await disconnectOrigin(event.name.slice(DISCONNECT_PREFIX.length));
    changed = true;
  } else if (event.name.startsWith(REMOVE_TOKEN_PREFIX)) {
    // Name shape: `remove-token:<network>:<contractId>`.
    const target = event.name.slice(REMOVE_TOKEN_PREFIX.length);
    const separator = target.indexOf(':');
    const network = target.slice(0, separator);
    if ((NETWORK_NAMES as readonly string[]).includes(network)) {
      await removeToken(network as NetworkName, target.slice(separator + 1));
      changed = true;
    }
  } else if (event.name.startsWith(USE_ACCOUNT_PREFIX)) {
    // The click is the user's own switch action. Only a revealed index may
    // be activated, so a button name from a stale page (or a malformed one)
    // is a no-op; the state helper re-checks membership under the lock.
    const index = Number(event.name.slice(USE_ACCOUNT_PREFIX.length));
    const { accounts } = await getState();
    if (accounts.includes(index)) {
      await setActiveAccount(index);
      changed = true;
    }
  } else if (event.name === ADD_ACCOUNT_BUTTON) {
    changed = await addAccountFlow();
  }

  if (changed) {
    const { content } = await homePage();
    await snap.request({
      method: 'snap_updateInterface',
      params: { id, ui: content },
    });
  }
};
