import { describe, expect, it } from '@jest/globals';

import { latestOnly } from './latest';

describe('latestOnly', () => {
  it('lets a single read commit', () => {
    const latest = latestOnly();
    expect(latest.claim()()).toBe(true);
  });

  it('drops a read that a later one has superseded', () => {
    // The ordinary overlap: a slow read for one account is still in flight
    // when a faster read for the next one answers.
    const latest = latestOnly();
    const first = latest.claim();
    const second = latest.claim();

    expect(second()).toBe(true);
    expect(first()).toBe(false);
  });

  it('keeps the newest claim current however many precede it', () => {
    const latest = latestOnly();
    const claims = [latest.claim(), latest.claim(), latest.claim()];

    expect(claims.map((current) => current())).toStrictEqual([
      false,
      false,
      true,
    ]);
  });

  it('answers the same way however often it is asked', () => {
    // Callers ask once before committing and again in a `finally`; the
    // second answer has to agree with the first.
    const latest = latestOnly();
    const only = latest.claim();

    expect(only()).toBe(true);
    expect(only()).toBe(true);
  });

  it('disowns an outstanding read at the moment the context changes', () => {
    // The gap a counter alone leaves open. The account changes, which
    // invalidates what is in flight, and the reply for the previous account
    // arrives before the read that replaces it has even started.
    const latest = latestOnly();
    const inFlight = latest.claim();

    latest.invalidate();

    expect(inFlight()).toBe(false);
  });

  it('does not disown the read that follows an invalidation', () => {
    const latest = latestOnly();
    latest.claim();
    latest.invalidate();

    const replacement = latest.claim();

    expect(replacement()).toBe(true);
  });

  it('keeps separate trackers independent', () => {
    // Wallet state and the history table each keep their own; one panel
    // reloading must not silence the other.
    const wallet = latestOnly();
    const history = latestOnly();
    const walletRead = wallet.claim();

    history.claim();
    history.invalidate();

    expect(walletRead()).toBe(true);
  });
});
