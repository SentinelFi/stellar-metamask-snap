import { Account, StrKey, TransactionBuilder } from '@stellar/stellar-sdk/base';

/**
 * Fee offered per operation, in stroops (0.001 XLM).
 *
 * The protocol minimum is 100 stroops. This is deliberately 100 times that:
 * the fee is a bid, not a price, and the ledger charges the market-clearing
 * rate rather than what was offered, so a headroom that costs a tenth of a
 * cent is what keeps a demo transaction from being dropped during a surge.
 */
export const BASE_FEE_STROOPS = '10000';

/**
 * Seconds a built transaction stays valid.
 *
 * Every transaction this page builds carries an upper time bound. An envelope
 * without one stays submittable forever, so a signature the user thought was
 * spent on a transaction that failed can be replayed later by anyone holding
 * it. Three minutes is comfortably longer than a MetaMask review takes.
 */
export const TX_TIMEOUT_SECONDS = 180;

/** The longest UTF-8 text memo the protocol accepts, in bytes. */
export const MAX_MEMO_BYTES = 28;

/**
 * Starts a transaction builder for the wallet account.
 *
 * @param source - The `G...` source account.
 * @param sequence - The account's current sequence, from Horizon. The builder
 * increments it, so this is the value the account holds now.
 * @param networkPassphrase - The active network's passphrase.
 * @param operationCount - How many operations the transaction will carry; the
 * offered fee scales with it.
 * @returns The builder.
 */
export function newBuilder(
  source: string,
  sequence: string,
  networkPassphrase: string,
  operationCount = 1,
): TransactionBuilder {
  return new TransactionBuilder(new Account(source, sequence), {
    fee: String(BigInt(BASE_FEE_STROOPS) * BigInt(operationCount)),
    networkPassphrase,
  });
}

/**
 * Whether a string is an address a payment can be sent to.
 *
 * Muxed (`M...`) addresses are accepted alongside `G...`: they name a real
 * account with a subaccount id attached, and Stellar payments support them.
 *
 * @param value - The candidate address.
 * @returns True when the address is a valid, checksum-correct destination.
 */
export function isValidDestination(value: string): boolean {
  return (
    StrKey.isValidEd25519PublicKey(value) ||
    StrKey.isValidMed25519PublicKey(value)
  );
}

/**
 * The `G...` account behind a destination, which is what Horizon indexes and
 * what an existence check has to ask about.
 *
 * @param value - A `G...` or `M...` destination.
 * @returns The underlying account address, or null when the input is neither.
 */
export function baseAccount(value: string): string | null {
  if (StrKey.isValidEd25519PublicKey(value)) {
    return value;
  }
  if (StrKey.isValidMed25519PublicKey(value)) {
    return StrKey.encodeEd25519PublicKey(
      StrKey.decodeMed25519PublicKey(value).subarray(0, 32),
    );
  }
  return null;
}

/** A positive decimal amount with at most seven decimal places. */
const AMOUNT_PATTERN = /^\d{1,15}(?:\.\d{1,7})?$/u;

/**
 * Validates a user-entered amount against Stellar's precision.
 *
 * Checked as a string, never by parsing to a number: `0.1 + 0.2` is the
 * classic demonstration of why a seven-decimal ledger amount must not make a
 * round trip through a float.
 *
 * @param value - The entered amount.
 * @returns An error message, or null when the amount is usable.
 */
export function validateAmount(value: string): string | null {
  if (!AMOUNT_PATTERN.test(value)) {
    return 'Enter an amount with at most 7 decimal places.';
  }
  if (Number.parseFloat(value) <= 0) {
    return 'Enter an amount greater than zero.';
  }
  return null;
}

/**
 * The byte length of a memo, which is what the 28-byte protocol limit counts.
 * A 28-character memo can be well over 28 bytes once it leaves ASCII.
 *
 * @param memo - The memo text.
 * @returns The UTF-8 byte length.
 */
export function memoByteLength(memo: string): number {
  return new TextEncoder().encode(memo).length;
}
