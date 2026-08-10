import type { Struct } from '@metamask/superstruct';
import {
  assert as assertStruct,
  boolean,
  enums,
  object,
  optional,
  string,
} from '@metamask/superstruct';

import { invalidRequest } from './errors';
import { NETWORK_NAMES } from '../state/networks';

/**
 * Validates request params against a struct, converting validation failures
 * into SEP-43 `invalid request` (-3) errors. Struct messages only echo the
 * caller's own input, so they are safe to return.
 *
 * @param params - The raw request params.
 * @param struct - The expected shape.
 * @returns The validated params, typed.
 */
export function validate<Type, Schema>(
  params: unknown,
  struct: Struct<Type, Schema>,
): Type {
  try {
    assertStruct(params, struct);
    return params;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid request parameters.';
    throw invalidRequest(message);
  }
}

export const SignTransactionParams = object({
  /** Base64-encoded TransactionEnvelope XDR. */
  xdr: string(),
  /** Must match the active network's passphrase when provided. */
  networkPassphrase: optional(string()),
  /** Must match the wallet's address when provided (SEP-43 option bag). */
  address: optional(string()),
  /** When true, submit the signed transaction to Horizon after signing. */
  submit: optional(boolean()),
});

export const SignMessageParams = object({
  message: string(),
  address: optional(string()),
});

export const SignAuthEntryParams = object({
  /** Base64-encoded SorobanAuthorizationEntry XDR. */
  authEntry: string(),
  networkPassphrase: optional(string()),
  address: optional(string()),
});

export const SetNetworkParams = object({
  network: enums(NETWORK_NAMES),
});

export const OptionalAddressParams = object({
  address: optional(string()),
});
