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
  MAX_TRACKED_ORIGINS,
  MAX_UNANSWERED_DIALOGS,
  recordDialogOpened,
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

  it('cools down an origin whose dialogs are never answered', () => {
    // The gap this closes: the rejection counter only advances on an explicit
    // SEP-43 -4, which needs the user to press reject. A hostile origin can
    // avoid it entirely by summoning dialogs the user simply ignores; the
    // request then unwinds when the platform request timeout expires, the snap
    // sees no rejection, and the cooldown never engages however many dialogs
    // pile up. Counting opens is what reaches that case.
    for (let i = 0; i < MAX_UNANSWERED_DIALOGS - 1; i++) {
      recordDialogOpened(ORIGIN);
      expect(check(ORIGIN)).toBeNull();
    }
    recordDialogOpened(ORIGIN);
    expect(check(ORIGIN)).not.toBeNull();
  });

  it('lets a rejection trip the tighter threshold first', () => {
    // Opens advance on every dialog, rejections only on refusals, so a user
    // who actually rejects must hit the rejection rule (and its more accurate
    // message) before the coarser unanswered-dialog rule can apply.
    for (let i = 0; i < MAX_CONSECUTIVE_REJECTIONS; i++) {
      recordDialogOpened(ORIGIN);
      recordDialogRejection(ORIGIN);
    }
    expect(MAX_CONSECUTIVE_REJECTIONS).toBeLessThan(MAX_UNANSWERED_DIALOGS);
    expect(check(ORIGIN)).not.toBeNull();
  });

  it('clears the unanswered count on an approval', () => {
    // An approval is positive evidence the dialogs reach a user who engages.
    for (let i = 0; i < MAX_UNANSWERED_DIALOGS - 1; i++) {
      recordDialogOpened(ORIGIN);
    }
    clearDialogRejections(ORIGIN);
    for (let i = 0; i < MAX_UNANSWERED_DIALOGS - 1; i++) {
      recordDialogOpened(ORIGIN);
      expect(check(ORIGIN)).toBeNull();
    }
  });

  it('tracks unanswered dialogs per origin', () => {
    for (let i = 0; i < MAX_UNANSWERED_DIALOGS; i++) {
      recordDialogOpened(ORIGIN);
    }
    expect(check(ORIGIN)).not.toBeNull();
    expect(check('https://other.example')).toBeNull();
  });
});

describe('tracked-origin bound', () => {
  beforeEach(() => {
    resetDialogThrottle();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('evicts the least recently used origin once the map is full', () => {
    // Filling the map with other origins pushes out the first one's partial
    // rejection count. Eviction fails open by design: the evicting party
    // already controls that many origins, each of which had to pass a
    // snap-access approval, so the bound is a memory cap, not a gate.
    recordDialogOpened(ORIGIN);
    recordDialogRejection(ORIGIN);
    for (let index = 0; index < MAX_TRACKED_ORIGINS; index += 1) {
      recordDialogOpened(`https://other-${index}.example`);
    }
    // Two more rejections would have blocked a tracked origin; the evicted
    // one starts over from zero.
    recordDialogOpened(ORIGIN);
    recordDialogRejection(ORIGIN);
    recordDialogOpened(ORIGIN);
    recordDialogRejection(ORIGIN);
    expect(check(ORIGIN)).toBeNull();
  });

  it('keeps a blocked origin resident while it keeps calling', () => {
    // A blocked origin must not be able to rotate other origins in to evict
    // the record of its own cooldown: every refused call refreshes it.
    jest.spyOn(Date, 'now').mockImplementation(() => 1_000_000);
    for (let index = 0; index < MAX_CONSECUTIVE_REJECTIONS; index += 1) {
      recordDialogOpened(ORIGIN);
      recordDialogRejection(ORIGIN);
    }
    expect(check(ORIGIN)).not.toBeNull();
    for (let index = 0; index < MAX_TRACKED_ORIGINS - 1; index += 1) {
      recordDialogOpened(`https://other-${index}.example`);
      expect(check(ORIGIN)).not.toBeNull();
    }
    expect(check(ORIGIN)?.message).toContain('Too many rejected requests');
  });
});
