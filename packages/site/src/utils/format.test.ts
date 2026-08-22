import { describe, expect, it } from '@jest/globals';

import { explorerAccountUrl, explorerTxUrl, isTransactionHash } from './format';

const ACCOUNT = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const HASH = 'a'.repeat(64);

describe('explorer links', () => {
  it('links only well-formed hashes and account addresses', () => {
    expect(explorerTxUrl('TESTNET', HASH)).toBe(
      `https://stellar.expert/explorer/testnet/tx/${HASH}`,
    );
    expect(explorerAccountUrl('PUBLIC', ACCOUNT)).toBe(
      `https://stellar.expert/explorer/public/account/${ACCOUNT}`,
    );
  });

  it('offers no link for a value that could steer the explorer path', () => {
    // The values come from Horizon, an endpoint this page does not control.
    // A string that is not a hash or an address gets no link at all rather
    // than a link labelled as "this transaction" that opens something else.
    for (const value of ['', '../x', `${HASH}?q=1`, 'g'.repeat(64), ACCOUNT]) {
      expect(explorerTxUrl('TESTNET', value)).toBeNull();
    }
    for (const value of ['', '../x', HASH, `${ACCOUNT}/x`]) {
      expect(explorerAccountUrl('TESTNET', value)).toBeNull();
    }
  });

  it('has no explorer for FUTURENET', () => {
    expect(explorerTxUrl('FUTURENET', HASH)).toBeNull();
    expect(explorerAccountUrl('FUTURENET', ACCOUNT)).toBeNull();
  });

  it('recognises a transaction hash as exactly 64 hex characters', () => {
    expect(isTransactionHash(HASH)).toBe(true);
    expect(isTransactionHash(HASH.toUpperCase())).toBe(true);
    expect(isTransactionHash(HASH.slice(1))).toBe(false);
    expect(isTransactionHash(`${HASH}0`)).toBe(false);
  });
});
