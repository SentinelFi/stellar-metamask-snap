import type {
  OnHomePageHandler,
  OnInstallHandler,
  OnRpcRequestHandler,
  OnUpdateHandler,
  OnUserInputHandler,
} from '@metamask/snaps-sdk';
import { SnapError, UserInputEventType } from '@metamask/snaps-sdk';
import { Box, Heading, Text } from '@metamask/snaps-sdk/jsx';
import { StrKey } from '@stellar/stellar-sdk';

import {
  ADD_ACCOUNT_BUTTON,
  DISCONNECT_PREFIX,
  FIND_ACCOUNT_FORM,
  FIND_ACCOUNT_INPUT,
  REMOVE_TOKEN_PREFIX,
  USE_ACCOUNT_PREFIX,
  homePage,
} from './handlers/home';
import { installWelcome, updateNotice } from './handlers/install';
import { findAccountIndexByAddress, getAddressForIndex } from './keys';
import { route } from './rpc/router';
import {
  disconnectOrigin,
  getState,
  MAX_ACCOUNT_INDEX,
  nextAccountIndex,
  removeToken,
  revealAccount,
  revealAccountsThrough,
  setActiveAccount,
} from './state';
import type { NetworkName } from './state/networks';
import { NETWORK_NAMES } from './state/networks';
import { AddAccountDialog, FindAccountDialog } from './ui/dialogs';

/** A plain integer index as the home-page controls render it. */
const INDEX_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

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
 * `homePage` already degrades the sections that depend on derivation or on the
 * network, so reaching this catch means the state read itself failed and there
 * is nothing left to render from. A minimal page is still better than a thrown
 * error: the platform renders an escaping throw as a bare failure, and the
 * dapp-facing error laundering in `rpc/router.ts` does not cover this surface,
 * so an internal message could surface verbatim.
 *
 * @returns The home page content.
 */
export const onHomePage: OnHomePageHandler = async () => {
  try {
    return await homePage();
  } catch {
    return {
      content: (
        <Box>
          <Heading>Stellar Soroban</Heading>
          <Text>
            This page could not be loaded. Close it and open it again; if that
            keeps happening, reload MetaMask.
          </Text>
        </Box>
      ),
    };
  }
};

/**
 * One-time welcome dialog after installation.
 *
 * @returns Resolves when dismissed.
 */
export const onInstall: OnInstallHandler = async () => installWelcome();

/**
 * Post-update notice, shown only when an existing connection grant needs
 * re-consent under the current disclosure.
 *
 * @returns Resolves when dismissed, or immediately when nothing needs saying.
 */
export const onUpdate: OnUpdateHandler = async () => updateNotice();

/**
 * Shows a plain informational dialog.
 *
 * @param message - The text to show.
 */
async function notify(message: string): Promise<void> {
  await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'alert',
      content: (
        <Box>
          <Text>{message}</Text>
        </Box>
      ),
    },
  });
}

/**
 * Resolves the account-lookup query to a SEP-0005 index.
 *
 * Accepts either a plain index or a `G...` address. The address form is the
 * one that matters for someone moving in from another SEP-0005 wallet: they
 * know the address they already use, not the index it happens to sit at.
 * The search derives locally and makes no network request.
 *
 * @param query - The raw user input.
 * @returns The located index, or a message explaining why there is none.
 */
async function resolveAccountQuery(
  query: string,
): Promise<{ index: number } | { error: string }> {
  const trimmed = query.trim();
  if (trimmed === '') {
    return { error: 'Enter an account address or index to look for.' };
  }

  if (INDEX_PATTERN.test(trimmed)) {
    const index = Number(trimmed);
    if (index >= MAX_ACCOUNT_INDEX) {
      return {
        error: `Account index out of range: indices run from 0 to ${
          MAX_ACCOUNT_INDEX - 1
        }.`,
      };
    }
    return { index };
  }

  if (!StrKey.isValidEd25519PublicKey(trimmed)) {
    return {
      error:
        'Not a Stellar account address or index. Enter a G… address, or a number such as 3.',
    };
  }

  const index = await findAccountIndexByAddress(trimmed);
  if (index === null) {
    return {
      error: `That address is not derived from this wallet's secret recovery phrase (searched accounts 0 to ${
        MAX_ACCOUNT_INDEX - 1
      }). A Stellar account created from a different phrase cannot be added here.`,
    };
  }
  return { index };
}

/**
 * Locates an account by address or index and reveals every account up to it
 * after one confirmation, instead of one confirmation per index.
 *
 * @param query - The raw lookup input from the home-page form.
 * @returns True when accounts were added.
 */
async function findAccountFlow(query: string): Promise<boolean> {
  const resolved = await resolveAccountQuery(query);
  if ('error' in resolved) {
    await notify(resolved.error);
    return false;
  }

  const { index } = resolved;
  const from = nextAccountIndex(await getState());
  if (index < from) {
    await notify(`Account ${index} is already in your account list.`);
    return false;
  }

  const address = await getAddressForIndex(index);
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <FindAccountDialog
          index={index}
          address={address}
          count={index - from + 1}
          from={from}
        />
      ),
    },
  });
  if (!approved) {
    return false;
  }
  const added = await revealAccountsThrough(index, from);
  return added.length > 0;
}

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
    await notify(
      `Account limit reached: at most ${MAX_ACCOUNT_INDEX} accounts.`,
    );
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
 * Applies one home-page interaction: "Disconnect" buttons revoke an origin's
 * connection grant, "Remove" buttons stop tracking a token, "Use" buttons
 * switch the active account, "Add account" reveals the next account after a
 * confirmation, and the account-lookup form reaches a specific account by
 * address or index.
 *
 * @param event - The user input event.
 * @returns True when state changed and the page needs re-rendering.
 */
async function applyUserInput(
  event: Parameters<OnUserInputHandler>[0]['event'],
): Promise<boolean> {
  if (event.type === UserInputEventType.FormSubmitEvent) {
    if (event.name !== FIND_ACCOUNT_FORM) {
      return false;
    }
    const query = event.value[FIND_ACCOUNT_INPUT];
    return findAccountFlow(typeof query === 'string' ? query : '');
  }

  if (event.type !== UserInputEventType.ButtonClickEvent || !event.name) {
    return false;
  }

  if (event.name.startsWith(DISCONNECT_PREFIX)) {
    await disconnectOrigin(event.name.slice(DISCONNECT_PREFIX.length));
    return true;
  }
  if (event.name.startsWith(REMOVE_TOKEN_PREFIX)) {
    // Name shape: `remove-token:<network>:<contractId>`. Only this snap's
    // own page emits these names, so a missing separator cannot occur in
    // practice; it is still checked so a malformed name is a clean no-op
    // instead of slicing into a nonsense network string.
    const target = event.name.slice(REMOVE_TOKEN_PREFIX.length);
    const separator = target.indexOf(':');
    const network = separator === -1 ? null : target.slice(0, separator);
    if (
      network === null ||
      !(NETWORK_NAMES as readonly string[]).includes(network)
    ) {
      return false;
    }
    await removeToken(network as NetworkName, target.slice(separator + 1));
    return true;
  }
  if (event.name.startsWith(USE_ACCOUNT_PREFIX)) {
    // The click is the user's own switch action. Only a revealed index may
    // be activated, so a button name from a stale page (or a malformed one)
    // is a no-op; the state helper re-checks membership under the lock.
    // `Number` is not enough on its own: it reads an empty suffix as 0 and
    // accepts hex, exponent, and whitespace-padded forms, none of which this
    // page ever renders.
    const suffix = event.name.slice(USE_ACCOUNT_PREFIX.length);
    const index = INDEX_PATTERN.test(suffix) ? Number(suffix) : -1;
    const { accounts } = await getState();
    if (!accounts.includes(index)) {
      return false;
    }
    await setActiveAccount(index);
    return true;
  }
  if (event.name === ADD_ACCOUNT_BUTTON) {
    return addAccountFlow();
  }
  return false;
}

/**
 * Runs one home-page interaction, turning a failure into the same kind of
 * dialog every other user-facing refusal in these flows uses.
 *
 * The paths that reach here throw for real reasons, not only exotic ones: both
 * reveal helpers re-check under the state lock that the account set did not
 * move while their dialog was open, and refuse when it did. Left uncaught,
 * that surfaces as a bare platform error instead of the sentence explaining
 * what to do, and skips the re-render, so a page whose state may already have
 * changed keeps showing the old view.
 *
 * Always asks for a re-render. A throw says nothing about whether a write
 * landed before it, and this page is where the user checks what is currently
 * granted, so re-reading state is the answer that cannot be wrong.
 *
 * @param event - The user input event.
 * @returns True when the page should be re-rendered.
 */
async function applyUserInputSafely(
  event: Parameters<OnUserInputHandler>[0]['event'],
): Promise<boolean> {
  try {
    return await applyUserInput(event);
  } catch (error) {
    await notify(
      error instanceof SnapError
        ? error.message
        : 'Something went wrong. Close this page and try again.',
    );
    return true;
  }
}

/**
 * Handle home-page interactions, re-rendering the page when state changed.
 *
 * @param args - The user input handler args.
 * @param args.id - The interface ID to update.
 * @param args.event - The user input event.
 */
export const onUserInput: OnUserInputHandler = async ({ id, event }) => {
  if (!(await applyUserInputSafely(event))) {
    return;
  }
  const { content } = await homePage();
  await snap.request({
    method: 'snap_updateInterface',
    params: { id, ui: content },
  });
};
