import { describe, expect, it } from '@jest/globals';
import { SnapError } from '@metamask/snaps-sdk';

import {
  SEP43_ERROR_CODES,
  externalServiceError,
  internalError,
  invalidRequest,
  userRejected,
} from './errors';

/**
 * Reads the SEP-43 code the factory attached: it lives in `error.data.code`
 * (the second `SnapError` constructor argument), which is what MetaMask
 * surfaces to the dapp as `error.data.code` and the connector reads.
 *
 * @param error - The SnapError to inspect.
 * @returns The SEP-43 code.
 */
function sep43Code(error: SnapError): number | undefined {
  return (error.data as { code?: number } | undefined)?.code;
}

describe('SEP-43 error factories', () => {
  it('all produce SnapError instances', () => {
    for (const error of [
      userRejected(),
      invalidRequest('x'),
      externalServiceError('x'),
      internalError(),
    ]) {
      expect(error).toBeInstanceOf(SnapError);
    }
  });

  it('userRejected -> -4 with the Freighter-compatible message', () => {
    const error = userRejected();
    expect(error.message).toBe('The user rejected this request.');
    expect(sep43Code(error)).toBe(SEP43_ERROR_CODES.userRejected);
    expect(SEP43_ERROR_CODES.userRejected).toBe(-4);
  });

  it('invalidRequest -> -3 with the supplied message', () => {
    const error = invalidRequest('bad param');
    expect(error.message).toBe('bad param');
    expect(sep43Code(error)).toBe(SEP43_ERROR_CODES.invalidRequest);
  });

  it('externalServiceError -> -2', () => {
    expect(sep43Code(externalServiceError('down'))).toBe(
      SEP43_ERROR_CODES.externalService,
    );
  });

  it('internalError -> -1 with a generic message (no internal leak)', () => {
    const error = internalError();
    expect(error.message).toBe('Internal error.');
    expect(sep43Code(error)).toBe(SEP43_ERROR_CODES.internal);
  });
});
