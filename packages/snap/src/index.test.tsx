import { expect } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';

/**
 * Official SEP-0005 test vector 1 (no passphrase):
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
 */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const SEP5_ADDRESS_1 =
  'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

describe('onRpcRequest', () => {
  describe('stellar_getAddress (Spike B: SEP-0005 derivation)', () => {
    it('derives the official SEP-0005 test vector address at index 0', async () => {
      const { request } = await installSnap({
        options: { secretRecoveryPhrase: SEP5_MNEMONIC },
      });

      const response = await request({ method: 'stellar_getAddress' });
      expect(response).toRespondWith({ address: SEP5_ADDRESS_0, index: 0 });
    });

    it('derives the official SEP-0005 test vector address at index 1', async () => {
      const { request } = await installSnap({
        options: { secretRecoveryPhrase: SEP5_MNEMONIC },
      });

      const response = await request({
        method: 'stellar_getAddress',
        params: { index: 1 },
      });
      expect(response).toRespondWith({ address: SEP5_ADDRESS_1, index: 1 });
    });
  });

  describe('stellar_sdkSmoke (Spike A: stellar-sdk under SES)', () => {
    it('builds, signs, verifies, and round-trips a transaction', async () => {
      const { request } = await installSnap();

      const response = await request({ method: 'stellar_sdkSmoke' });

      expect(response).toRespondWith(
        expect.objectContaining({
          strKeyRoundTrip: true,
          signatureValid: true,
          xdrRoundTrip: true,
          envelopeType: 'envelopeTypeTx',
          memo: 'phase-0 spike',
          address: expect.stringMatching(/^G[A-Z2-7]{55}$/u),
          txHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
        }),
      );
    });
  });

  it('throws an error if the requested method does not exist', async () => {
    const { request } = await installSnap();

    const response = await request({ method: 'foo' });

    expect(response).toRespondWithError({
      code: -32603,
      message: 'Method not found.',
      stack: expect.any(String),
    });
  });
});
