import type { Json, JsonRpcRequest } from '@metamask/snaps-sdk';
import { MethodNotFoundError, SnapError } from '@metamask/snaps-sdk';

import { internalError, SEP43_ERROR_CODES } from './errors';
import { assertRateAllowed, withInflightBudget } from './limiter';
import {
  assertDialogAllowed,
  DIALOG_METHODS,
  recordDialogRejection,
} from './throttle';
import { getAddress, requestAccess } from '../handlers/access';
import { addToken, getBalances, fund } from '../handlers/account';
import { getAccounts, setActiveAccount } from '../handlers/accounts';
import { getNetwork, getNetworkDetails, setNetwork } from '../handlers/network';
import { signAuthEntry, signMessage, signTransaction } from '../handlers/sign';

type Handler = (origin: string, params: unknown) => Promise<Json>;

/**
 * The SEP-43 / Freighter-shaped RPC surface. Method names are unprefixed —
 * the snap ID already namespaces them.
 */
const HANDLERS: Record<string, Handler> = {
  requestAccess: async (origin) => requestAccess(origin),
  getAddress: async (origin) => getAddress(origin),
  getNetwork: async () => getNetwork(),
  getNetworkDetails: async () => getNetworkDetails(),
  setNetwork: async (origin, params) => setNetwork(origin, params),
  signTransaction: async (origin, params) => signTransaction(origin, params),
  signAuthEntry: async (origin, params) => signAuthEntry(origin, params),
  signMessage: async (origin, params) => signMessage(origin, params),
  fund: async (origin, params) => fund(origin, params),
  getBalances: async (origin, params) => getBalances(origin, params),
  addToken: async (origin, params) => addToken(origin, params),
  getAccounts: async (origin) => getAccounts(origin),
  setActiveAccount: async (origin, params) => setActiveAccount(origin, params),
};

/**
 * Whether an error is the user rejecting a dialog (SEP-43 code -4).
 *
 * @param error - The caught `SnapError`.
 * @returns True for user rejections.
 */
function isUserRejection(error: SnapError): boolean {
  return (
    typeof error.data === 'object' &&
    error.data !== null &&
    !Array.isArray(error.data) &&
    error.data.code === SEP43_ERROR_CODES.userRejected
  );
}

/**
 * Routes a JSON-RPC request to its handler. Unexpected exceptions are
 * replaced with a generic internal error so implementation details never
 * leak to dapps. Dialog-bearing methods carry a per-origin cooldown after
 * repeated consecutive rejections (dialog-fatigue relief).
 *
 * @param origin - The requesting dapp origin (provided by MetaMask).
 * @param request - The JSON-RPC request.
 * @returns The handler result.
 */
export async function route(
  origin: string,
  request: JsonRpcRequest,
): Promise<Json> {
  // Own-property dispatch: a name like `constructor` or `toString` resolves
  // an inherited JavaScript property on a plain object, which must be
  // method-not-found, never a callable.
  const handler = Object.prototype.hasOwnProperty.call(HANDLERS, request.method)
    ? HANDLERS[request.method]
    : undefined;
  if (!handler) {
    // MethodNotFoundError extends SnapError/Error; the rule cannot see it.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw new MethodNotFoundError(`Method not found: ${request.method}`);
  }

  const dialogMethod = DIALOG_METHODS.has(request.method);
  if (dialogMethod) {
    assertDialogAllowed(origin);
  }
  // Dialog-free methods with external side effects are rate limited, and
  // every request counts against a per-origin in-flight budget, so parallel
  // calls cannot multiply pre-dialog work without bound.
  assertRateAllowed(origin, request.method);

  try {
    // The rejection count is NOT cleared here on success: handlers clear it
    // themselves at the moment a dialog is approved. Some dialog methods can
    // succeed without showing any dialog (setNetwork to the current network,
    // setActiveAccount to the active index, requestAccess with a standing
    // grant), and a router-level clear on those would let a connected origin
    // reset its count between rejections and never reach the cooldown.
    return await withInflightBudget(origin, async () =>
      handler(origin, request.params),
    );
  } catch (error) {
    if (error instanceof SnapError) {
      if (dialogMethod && isUserRejection(error)) {
        recordDialogRejection(origin);
      }
      throw error;
    }
    throw internalError();
  }
}
