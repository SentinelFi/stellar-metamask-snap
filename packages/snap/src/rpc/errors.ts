import { SnapError } from '@metamask/snaps-sdk';

/**
 * SEP-0043 wallet error codes, surfaced to dapps in `error.data.code` so the
 * connector package can map them 1:1 onto the standard interface.
 *
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0043.md
 */
export const SEP43_ERROR_CODES = {
  /** An unexpected error inside the wallet. */
  internal: -1,
  /** An external service (Horizon, RPC, friendbot) failed. */
  externalService: -2,
  /** The client request was invalid. */
  invalidRequest: -3,
  /** The user rejected the request. Do not retry. */
  userRejected: -4,
} as const;

/**
 * The user rejected the request. Message string mirrors Freighter for
 * drop-in compatibility.
 *
 * @returns A `SnapError` carrying SEP-43 code -4.
 */
export function userRejected(): SnapError {
  return new SnapError('The user rejected this request.', {
    code: SEP43_ERROR_CODES.userRejected,
  });
}

/**
 * The client request was invalid.
 *
 * @param message - A safe, client-facing description of the problem.
 * @returns A `SnapError` carrying SEP-43 code -3.
 */
export function invalidRequest(message: string): SnapError {
  return new SnapError(message, { code: SEP43_ERROR_CODES.invalidRequest });
}

/**
 * An external service (Horizon, friendbot) failed.
 *
 * @param message - A safe, client-facing description of the failure.
 * @returns A `SnapError` carrying SEP-43 code -2.
 */
export function externalServiceError(message: string): SnapError {
  return new SnapError(message, { code: SEP43_ERROR_CODES.externalService });
}

/**
 * An unexpected internal error. Deliberately generic: internal details must
 * never leak to dapps.
 *
 * @returns A `SnapError` carrying SEP-43 code -1.
 */
export function internalError(): SnapError {
  return new SnapError('Internal error.', {
    code: SEP43_ERROR_CODES.internal,
  });
}
