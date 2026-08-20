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
import { StrKey } from '@stellar/stellar-sdk/base';

import { invalidRequest } from './errors';
import { AccountIndexStruct } from '../state';
import { NETWORK_NAMES } from '../state/networks';
import { isContractId } from '../stellar/token';

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
 * Upper bound on a dapp-supplied network passphrase. The field is only ever
 * compared against the active network's passphrase (the longest real one is
 * under 50 characters), so the bound costs nothing legitimate and keeps this
 * the one string field without a cap from accepting arbitrary payloads.
 */
export const MAX_NETWORK_PASSPHRASE_LENGTH = 256;

/**
 * A non-empty base64/text string bounded to `max` characters.
 *
 * @param max - The maximum allowed length.
 * @returns A superstruct string struct with the length bound applied.
 */
const boundedString = (max: number): Struct<string, null> =>
  size(string(), 1, max);

/**
 * Upper bound on address-shaped fields, applied *before* the strkey decoder
 * runs.
 *
 * A strkey address is 56 characters, so this is generous rather than tight.
 * It exists because `refine(string(), ...)` alone accepts a string of any
 * length and only rejects it after the whole value has been materialized and
 * handed to `StrKey`: the resulting bound describes what survives validation,
 * not what validation processes. Every other dapp-controlled string in this
 * module carries an explicit `size()`, and the address fields are reachable on
 * `signTransaction`, `signMessage`, `signAuthEntry`, `fund`, `getBalances`,
 * and `addToken`, so they get the same treatment rather than being the
 * exception a future field is copied from.
 */
export const MAX_ADDRESS_LENGTH = 128;

/**
 * A classic `G...` ed25519 account address. Callers interpolate addresses
 * into Horizon URL paths, so shape validation here doubles as an injection
 * guard.
 */
export const StellarAddress = refine(
  size(string(), 1, MAX_ADDRESS_LENGTH),
  'StellarAddress',
  (value) =>
    StrKey.isValidEd25519PublicKey(value)
      ? true
      : 'Expected a Stellar account address (G...).',
);

/**
 * A Soroban contract address (`C...` strkey shape). Validated at the RPC
 * boundary like every other address the snap accepts, so a value that cannot
 * name a contract is rejected before it reaches metadata reads, and the
 * field carries an implicit length bound instead of none.
 */
export const SorobanContractAddress = refine(
  size(string(), 1, MAX_ADDRESS_LENGTH),
  'SorobanContractAddress',
  (value) =>
    isContractId(value)
      ? true
      : 'Expected a Soroban token contract address (C...).',
);

/**
 * The optional dapp-supplied network passphrase, bounded: it is only ever
 * compared for equality with the active network's passphrase.
 */
const NetworkPassphraseOption = optional(
  boundedString(MAX_NETWORK_PASSPHRASE_LENGTH),
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
  networkPassphrase: NetworkPassphraseOption,
  /** Selects the signing account; must be one the wallet holds. */
  address: AddressOption,
  /** When true, submit the signed transaction to Horizon after signing. */
  submit: optional(boolean()),
});

export const SignMessageParams = object({
  message: boundedString(MAX_MESSAGE_LENGTH),
  /**
   * SEP-43 lists `networkPassphrase` for `signMessage` too. A SEP-53
   * signature is not bound to a network, so the field changes nothing about
   * what is signed; it is accepted so a conformant caller is not rejected,
   * and compared against the active network when present so a site that
   * states a network it is not on hears about it.
   */
  networkPassphrase: NetworkPassphraseOption,
  address: AddressOption,
});

export const SignAuthEntryParams = object({
  /** Base64-encoded SorobanAuthorizationEntry XDR. */
  authEntry: boundedString(MAX_AUTH_ENTRY_LENGTH),
  networkPassphrase: NetworkPassphraseOption,
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
  contractId: SorobanContractAddress,
  networkPassphrase: NetworkPassphraseOption,
});
