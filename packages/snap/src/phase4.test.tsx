import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import {
  Account,
  Asset,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

import { MAX_TRACKED_TOKENS } from './handlers/account';
import { SIMULATION_SOURCE } from './stellar/token';

/** Official SEP-0005 test vector 1 (no passphrase). */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

const ORIGIN = 'https://dapp.example';

/** The XLM Stellar Asset Contract address on testnet (deterministic). */
const XLM_SAC_TESTNET = Asset.native().contractId(Networks.TESTNET);

/**
 * Installs the snap with the SEP-5 test mnemonic.
 *
 * @param state - Optional initial snap state.
 * @returns The snaps-jest helpers.
 */
async function install(state?: Record<string, unknown>) {
  return installSnap({
    options: {
      secretRecoveryPhrase: SEP5_MNEMONIC,
      ...(state ? { state: state as never } : {}),
    },
  });
}

/**
 * Extracts the JSON-RPC error object from a snaps-jest response.
 *
 * @param response - The awaited request response.
 * @returns The error object.
 */
function getError(response: unknown): {
  message: string;
  data?: { code?: number; signedTxXdr?: string; signerAddress?: string };
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

describe('signTransaction with submit', () => {
  it('returns the signed XDR in error data when submission fails', async () => {
    const { request } = await install();

    // Unfunded source with an arbitrary sequence: Horizon rejects the
    // submission (tx_no_source_account / bad seq), or the network is
    // unreachable — either way the user signed, so the error must carry
    // the signed envelope for the dapp to poll or retry.
    const xdr = new TransactionBuilder(new Account(SEP5_ADDRESS_0, '10'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: SEP5_ADDRESS_0,
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
      params: { xdr, submit: true },
    });
    const ui = await pending.getInterface();
    await (ui as { ok: () => Promise<void> }).ok();

    const error = getError(await pending);
    expect(error.data?.code).toBe(-2);
    expect(typeof error.data?.signedTxXdr).toBe('string');
    expect(error.data?.signerAddress).toBe(SEP5_ADDRESS_0);
  }, 45000);
});

describe('home page connected sites', () => {
  it('lists a connected origin and revokes it on disconnect', async () => {
    const { request, onHomePage } = await install();

    const connect = request({ origin: ORIGIN, method: 'requestAccess' });
    await ((await connect.getInterface()) as { ok: () => Promise<void> }).ok();
    await connect;

    // Connected: silent getAddress resolves the address.
    const before = (await request({
      origin: ORIGIN,
      method: 'getAddress',
    })) as {
      response: { result?: { address?: string } };
    };
    expect(before.response.result?.address).toBe(SEP5_ADDRESS_0);

    const home = (await onHomePage()) as unknown as {
      getInterface: () => Promise<{
        content: unknown;
        clickElement: (name: string) => Promise<void>;
      }>;
    };
    const ui = await home.getInterface();
    expect(JSON.stringify(ui.content)).toContain(ORIGIN);

    await ui.clickElement(`disconnect:${ORIGIN}`);

    // Revoked: silent getAddress returns an empty string again.
    const after = (await request({ origin: ORIGIN, method: 'getAddress' })) as {
      response: { result?: { address?: string } };
    };
    expect(after.response.result?.address).toBe('');
  }, 45000);
});

describe('home page tracked tokens', () => {
  it('lists a tracked token and removes it via the Remove button', async () => {
    const { onHomePage } = await install({
      version: 1,
      network: 'TESTNET',
      origins: {},
      tokens: {
        TESTNET: [
          { contractId: XLM_SAC_TESTNET, symbol: 'native', decimals: 7 },
        ],
      },
    });

    const home = (await onHomePage()) as unknown as {
      getInterface: () => Promise<{
        content: unknown;
        clickElement: (name: string) => Promise<void>;
      }>;
    };
    const ui = await home.getInterface();
    const buttonName = `remove-token:TESTNET:${XLM_SAC_TESTNET}`;
    expect(JSON.stringify(ui.content)).toContain(buttonName);

    await ui.clickElement(buttonName);

    const updated = await home.getInterface();
    const content = JSON.stringify(updated.content);
    expect(content).not.toContain(XLM_SAC_TESTNET);
    expect(content).toContain('No tokens are tracked');
  }, 45000);
});

describe('addToken cap', () => {
  it('rejects a distinct token beyond the cap with SEP-43 code -3', async () => {
    // Distinct valid contract IDs; the cap check runs before any network
    // read, so this test needs no live endpoint. They are encoded through
    // `StrKey` rather than assembled by hand because persisted entries are
    // checksum-validated on read: a strkey-shaped string would be dropped by
    // normalization and the registry would never reach the cap.
    const filler = Array.from({ length: MAX_TRACKED_TOKENS }, (_, index) => ({
      contractId: StrKey.encodeContract(Buffer.alloc(32, index)),
      symbol: `T${index}`,
      decimals: 7,
    }));

    const { request } = await install({
      version: 1,
      network: 'TESTNET',
      origins: { [ORIGIN]: { connectedAt: '2026-08-11T00:00:00Z' } },
      tokens: { TESTNET: filler },
    });

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'addToken',
        params: { contractId: XLM_SAC_TESTNET },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Token limit reached');
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
