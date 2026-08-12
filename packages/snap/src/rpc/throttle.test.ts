import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { SnapError } from '@metamask/snaps-sdk';

import {
  assertDialogAllowed,
  clearDialogRejections,
  COOLDOWN_MS,
  DIALOG_METHODS,
  MAX_CONSECUTIVE_REJECTIONS,
  recordDialogRejection,
  resetDialogThrottle,
} from './throttle';

const ORIGIN = 'https://dapp.example';

/**
 * Runs `assertDialogAllowed` and returns the thrown error, or null when the
 * origin is allowed.
 *
 * @param origin - The origin to check.
 * @returns The thrown `SnapError`, or null.
 */
function check(origin: string): SnapError | null {
  try {
    assertDialogAllowed(origin);
    return null;
  } catch (error) {
    return error as SnapError;
  }
}

describe('dialog throttle', () => {
  beforeEach(() => {
    resetDialogThrottle();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('covers exactly the dialog-bearing methods', () => {
    expect([...DIALOG_METHODS].sort()).toStrictEqual([
      'addToken',
      'requestAccess',
      'setActiveAccount',
      'setNetwork',
      'signAuthEntry',
      'signMessage',
      'signTransaction',
    ]);
    // Silent / dialog-free methods must never be throttled.
    for (const method of ['getAddress', 'getBalances', 'fund', 'getNetwork']) {
      expect(DIALOG_METHODS.has(method)).toBe(false);
    }
  });

  it('allows an origin with no rejection history', () => {
    expect(check(ORIGIN)).toBeNull();
  });

  it('stays allowed below the consecutive-rejection threshold', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS - 1; i++) {
      recordDialogRejection(ORIGIN);
      expect(check(ORIGIN)).toBeNull();
    }
  });

  it('blocks with SEP-43 code -3 once the threshold is reached', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS; i++) {
      recordDialogRejection(ORIGIN);
    }
    const error = check(ORIGIN);
    expect(error).toBeInstanceOf(SnapError);
    expect((error?.data as { code?: number })?.code).toBe(-3);
    expect(error?.message).toContain('Try again in');
  });

  it('throttles per origin, not globally', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS; i++) {
      recordDialogRejection(ORIGIN);
    }
    expect(check(ORIGIN)).not.toBeNull();
    expect(check('https://other.example')).toBeNull();
  });

  it('lifts the cooldown after it expires and clears the slate', () => {
    const start = 1_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS; i++) {
      recordDialogRejection(ORIGIN);
    }
    expect(check(ORIGIN)).not.toBeNull();

    jest.spyOn(Date, 'now').mockReturnValue(start + COOLDOWN_MS);
    expect(check(ORIGIN)).toBeNull();
    // The slate is clean: one new rejection does not re-block.
    recordDialogRejection(ORIGIN);
    expect(check(ORIGIN)).toBeNull();
  });

  it('resets the consecutive count on a completed request', () => {
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS - 1; i++) {
      recordDialogRejection(ORIGIN);
    }
    clearDialogRejections(ORIGIN);
    // The chain restarts: the next rejection is number one, not the third.
    recordDialogRejection(ORIGIN);
    expect(check(ORIGIN)).toBeNull();
  });
});
