import type { OnRpcRequestHandler } from '@metamask/snaps-sdk';

import { deriveKeypair } from './stellar/keys';
import { runSdkSmoke } from './stellar/sdkSmoke';

/**
 * Handle incoming JSON-RPC requests, sent through `wallet_invokeSnap`.
 *
 * Phase 0 surface — spike methods only; the real SEP-43-shaped API arrives in
 * Phase 1.
 *
 * @param args - The request handler args as object.
 * @param args.request - A validated JSON-RPC request object.
 * @returns The result of the requested method.
 * @throws If the request method is not valid for this snap.
 */
export const onRpcRequest: OnRpcRequestHandler = async ({ request }) => {
  switch (request.method) {
    // Spike B: SEP-0005 derivation m/44'/148'/{index}' from the SRP.
    case 'stellar_getAddress': {
      const index =
        typeof (request.params as { index?: number } | undefined)?.index ===
        'number'
          ? (request.params as { index: number }).index
          : 0;
      const keypair = await deriveKeypair(index);
      return { address: keypair.publicKey(), index };
    }

    // Spike A: offline stellar-sdk exercise under SES.
    case 'stellar_sdkSmoke':
      return runSdkSmoke();

    default:
      throw new Error('Method not found.');
  }
};
