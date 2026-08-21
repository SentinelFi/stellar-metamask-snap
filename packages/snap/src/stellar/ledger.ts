import { integer, max, min } from '@metamask/superstruct';

/**
 * The largest ledger sequence the protocol can represent: a ledger's
 * sequence number is a `uint32` on the wire, and so is every field that
 * names one, including an authorization entry's `signatureExpirationLedger`.
 */
export const MAX_LEDGER_SEQUENCE = 0xffff_ffff;

/**
 * A ledger height as an endpoint may report it: a positive integer no larger
 * than the protocol can represent.
 *
 * Shared by every ledger-height field the snap consumes (the Soroban RPC's
 * `getLatestLedger` and simulation responses, Horizon's root endpoint) so
 * they all carry the same guarantee. A height is what bounds how long an
 * authorization signature stays valid, and arithmetic on it (`latest + N`,
 * `requested - latest`) must happen on values that are exact and that the
 * signed field can hold. The upper bound implies a safe integer, so a value
 * that passed `Number.isInteger` only because it lost precision is refused
 * too.
 */
export const LedgerSequenceStruct = max(min(integer(), 1), MAX_LEDGER_SEQUENCE);

/**
 * Whether a value is a representable ledger height, for callers that hold a
 * number rather than an unvalidated response.
 *
 * @param value - The candidate height.
 * @returns True for a positive safe integer within the `uint32` range.
 */
export function isLedgerSequence(value: number): boolean {
  return (
    Number.isSafeInteger(value) && value >= 1 && value <= MAX_LEDGER_SEQUENCE
  );
}
