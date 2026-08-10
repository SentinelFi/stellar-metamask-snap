import type {
  OnHomePageHandler,
  OnRpcRequestHandler,
} from '@metamask/snaps-sdk';

import { homePage } from './handlers/home';
import { route } from './rpc/router';

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
