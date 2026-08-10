import { describe, expect, it } from '@jest/globals';

import { isContractId } from './token';

describe('isContractId', () => {
  it('accepts a valid Soroban contract strkey', () => {
    expect(
      isContractId('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'),
    ).toBe(true);
  });

  it('rejects account (G) strkeys and non-contract input', () => {
    expect(
      isContractId('GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6'),
    ).toBe(false);
    expect(isContractId('not-a-contract')).toBe(false);
    expect(isContractId('')).toBe(false);
  });

  it('rejects a C-prefixed string of the wrong length', () => {
    expect(isContractId('CDLZFC3SYJYDZT7K67VZ')).toBe(false);
  });

  it('rejects lowercase (strkeys are uppercase base32)', () => {
    expect(
      isContractId('cdlzfc3syjydzt7k67vz75hpjvieuvnixf47zg2fb2rmqqvu2hhgcysc'),
    ).toBe(false);
  });
});
