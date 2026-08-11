import type {
  OnHomePageHandler,
  OnInstallHandler,
  OnRpcRequestHandler,
  OnUserInputHandler,
} from '@metamask/snaps-sdk';
import { UserInputEventType } from '@metamask/snaps-sdk';

import {
  DISCONNECT_PREFIX,
  REMOVE_TOKEN_PREFIX,
  homePage,
} from './handlers/home';
import { installWelcome } from './handlers/install';
import { route } from './rpc/router';
import { disconnectOrigin, removeToken } from './state';
import type { NetworkName } from './state/networks';
import { NETWORK_NAMES } from './state/networks';

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
 * Handle home-page interactions: "Disconnect" buttons revoke an origin's
 * connection grant, "Remove" buttons stop tracking a token. Either action
 * re-renders the page.
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
  }

  if (changed) {
    const { content } = await homePage();
    await snap.request({
      method: 'snap_updateInterface',
      params: { id, ui: content },
    });
  }
};
