import type { Struct } from '@metamask/superstruct';
import {
  assert,
  boolean,
  enums,
  object,
  optional,
  refine,
  size,
  string,
} from '@metamask/superstruct';
import { StrKey } from '@stellar/stellar-sdk';

import { invalidRequest } from './errors';
import { AccountIndexStruct } from '../state';
import { NETWORK_NAMES } from '../state/networks';

/**
 * Upper bounds on dapp-supplied payloads, enforced before any XDR parse so a
 * malicious dapp cannot force oversized parsing, recursion, or dialogs
 * (defense against resource exhaustion). Generous enough for legitimate
 * traffic: a Soroban wasm-upload envelope is the largest real case.
 */
export const MAX_XDR_LENGTH = 256 * 1024;
export const MAX_AUTH_ENTRY_LENGTH = 64 * 1024;
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * A non-empty base64/text string bounded to `max` characters.
 *
 * @param max - The maximum allowed length.
 * @returns A superstruct string struct with the length bound applied.
 */
const boundedString = (max: number): Struct<string, null> =>
  size(string(), 1, max);

/**
 * A classic `G...` ed25519 account address. Callers interpolate addresses
 * into Horizon URL paths, so shape validation here doubles as an injection
 * guard.
 */
export const StellarAddress = refine(string(), 'StellarAddress', (value) =>
  StrKey.isValidEd25519PublicKey(value)
    ? true
    : 'Expected a Stellar account address (G...).',
);

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
    assert(params, struct);
    return params;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Invalid request parameters.';
    throw invalidRequest(message);
  }
}

/**
 * The SEP-43 `address` option: which of the wallet's accounts should sign.
 *
 * Shape-validated at the boundary like every other address the snap accepts
 * (`OptionalAddressParams`), rather than being passed through as a free
 * string and left to fail later on an exact match against derived keys. One
 * validation standard for one concept: a value that is not an address cannot
 * name an account, so it is rejected before it reaches resolution, and the
 * field carries an implicit length bound instead of none.
 */
const AddressOption = optional(StellarAddress);

export const SignTransactionParams = object({
  /** Base64-encoded TransactionEnvelope XDR. */
  xdr: boundedString(MAX_XDR_LENGTH),
  /** Must match the active network's passphrase when provided. */
  networkPassphrase: optional(string()),
  /** Selects the signing account; must be one the wallet holds. */
  address: AddressOption,
  /** When true, submit the signed transaction to Horizon after signing. */
  submit: optional(boolean()),
});

export const SignMessageParams = object({
  message: boundedString(MAX_MESSAGE_LENGTH),
  address: AddressOption,
});

export const SignAuthEntryParams = object({
  /** Base64-encoded SorobanAuthorizationEntry XDR. */
  authEntry: boundedString(MAX_AUTH_ENTRY_LENGTH),
  networkPassphrase: optional(string()),
  address: AddressOption,
});

export const SetNetworkParams = object({
  network: enums(NETWORK_NAMES),
});

export const SetActiveAccountParams = object({
  /** A revealed SEP-0005 account index. */
  index: AccountIndexStruct,
});

export const OptionalAddressParams = object({
  address: optional(StellarAddress),
});

export const AddTokenParams = object({
  /** The Soroban token contract address (`C...`). */
  contractId: string(),
  networkPassphrase: optional(string()),
});
