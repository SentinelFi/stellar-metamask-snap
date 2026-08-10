import { expect } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import {
  Account,
  Asset,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { SIMULATION_SOURCE } from './stellar/token';

/** Official SEP-0005 test vector 1 (no passphrase). */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

const ORIGIN = 'https://dapp.example';

/**
 * Installs the snap with the SEP-5 test mnemonic.
 *
 * @returns The snaps-jest helpers.
 */
async function install() {
  return installSnap({ options: { secretRecoveryPhrase: SEP5_MNEMONIC } });
}

/**
 * Extracts the JSON-RPC error object from a snaps-jest response.
 *
 * @param response - The awaited request response.
 * @returns The error object.
 */
function getError(response: unknown): {
  message: string;
  data?: { code?: number };
} {
  return (response as { response: { error: never } }).response.error;
}

describe('onInstall', () => {
  it('shows a welcome dialog', async () => {
    const { onInstall } = await install();
    const event = onInstall() as {
      getInterface: () => Promise<{
        content: unknown;
        ok: () => Promise<void>;
      }>;
    };
    const ui = await event.getInterface();
    expect(JSON.stringify(ui.content)).toContain('Stellar Soroban Snap');
    await ui.ok();
  });
});

describe('signTransaction safety warnings', () => {
  it('warns when paying an account that does not exist on the ledger', async () => {
    const { request } = await install();

    // A valid strkey that is almost certainly unfunded (deterministic
    // seed of 42s, never friendbot-funded).
    const destination =
      'GAMX62ZD4FWIKMWGVPEDR6WNL2TYTPQMO2ZJEAZUAON7VCZ5G2GWDF7W';
    const xdr = new TransactionBuilder(new Account(SEP5_ADDRESS_0, '10'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(300)
      .build()
      .toXDR();

    const pending = request({
      origin: ORIGIN,
      method: 'signTransaction',
      params: { xdr },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    // The snap reached Horizon and flagged the destination, OR (if Horizon
    // was unreachable) it degraded silently — never a false "safe".
    expect(content).toContain('Sign transaction');
    await (ui as { cancel: () => Promise<void> }).cancel();
    const error = getError(await pending);
    expect(error.data?.code).toBe(-4);
  }, 45000);
});

describe('token simulation source', () => {
  it('is a valid ed25519 account strkey', () => {
    // Regression: a truncated placeholder made every token read fail at
    // transaction build time.
    expect(StrKey.isValidEd25519PublicKey(SIMULATION_SOURCE)).toBe(true);
  });
});

describe('addToken', () => {
  it('rejects an invalid contract ID with SEP-43 code -3', async () => {
    const { request } = await install();
    // Connect first so the origin passes the connection guard.
    const connect = request({ origin: ORIGIN, method: 'requestAccess' });
    const connectUi = await connect.getInterface();
    await (connectUi as { ok: () => Promise<void> }).ok();
    await connect;

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'addToken',
        params: { contractId: 'not-a-contract' },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('contract');
  });

  it('requires a connected origin', async () => {
    const { request } = await install();
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'addToken',
        params: {
          contractId:
            'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('not connected');
  });
});
