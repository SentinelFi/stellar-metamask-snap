import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import type { Transaction } from '@stellar/stellar-sdk';
import {
  Account,
  Asset,
  hash,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

/**
 * Official SEP-0005 test vector 1 (no passphrase):
 * https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0005.md
 */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';

const ORIGIN = 'https://dapp.example';

/** Version-2 state granting {@link ORIGIN} a standing connection. */
const CONNECTED_STATE = {
  version: 2,
  network: 'TESTNET',
  activeAccount: 0,
  accounts: [0],
  origins: {
    [ORIGIN]: { connectedAt: '2026-08-12T00:00:00Z', disclosureVersion: 1 },
  },
  tokens: {},
};

/**
 * Installs the snap with the SEP-5 test mnemonic.
 *
 * @param state - Optional initial snap state.
 * @returns The snaps-jest request helper.
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
  code: number;
  message: string;
  data?: { code?: number };
} {
  return (response as { response: { error: never } }).response.error;
}

/**
 * Extracts the JSON-RPC result from a snaps-jest response.
 *
 * @param response - The awaited request response.
 * @returns The result value.
 */
function getResult<Type>(response: unknown): Type {
  return (response as { response: { result: Type } }).response.result;
}

/**
 * Builds a classic payment transaction from the SEP-5 account.
 *
 * @param options - Optional overrides.
 * @param options.sequence - The account sequence before the transaction.
 * @param options.memo - Optional memo text.
 * @returns The base64 transaction envelope XDR.
 */
function buildPaymentXdr({
  sequence = '1',
  memo,
}: {
  sequence?: string;
  memo?: string;
} = {}): string {
  const builder = new TransactionBuilder(
    new Account(SEP5_ADDRESS_0, sequence),
    { fee: '100', networkPassphrase: Networks.TESTNET },
  )
    .addOperation(
      Operation.payment({
        destination: SEP5_ADDRESS_0,
        asset: Asset.native(),
        amount: '1.5',
      }),
    )
    .setTimeout(300);
  if (memo) {
    builder.addMemo(Memo.text(memo));
  }
  return builder.build().toXDR();
}

/**
 * Runs requestAccess and approves the dialog.
 *
 * @param request - The snaps-jest request helper.
 */
async function connect(
  request: Awaited<ReturnType<typeof install>>['request'],
) {
  const pending = request({ origin: ORIGIN, method: 'requestAccess' });
  const ui = await pending.getInterface();
  await (ui as { ok: () => Promise<void> }).ok();
  await pending;
}

describe('requestAccess / getAddress', () => {
  it('grants access after approval and derives the SEP-5 address', async () => {
    const { request } = await install();

    const pending = request({ origin: ORIGIN, method: 'requestAccess' });
    const ui = await pending.getInterface();
    expect(JSON.stringify(ui.content)).toContain('Connect to Stellar');
    await (ui as { ok: () => Promise<void> }).ok();

    expect(await pending).toRespondWith({ address: SEP5_ADDRESS_0 });

    // Once granted, requestAccess is silent and getAddress returns the address.
    expect(
      await request({ origin: ORIGIN, method: 'requestAccess' }),
    ).toRespondWith({ address: SEP5_ADDRESS_0 });
    expect(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    ).toRespondWith({ address: SEP5_ADDRESS_0 });
  });

  it('rejecting the connect dialog returns SEP-43 code -4', async () => {
    const { request } = await install();

    const pending = request({ origin: ORIGIN, method: 'requestAccess' });
    const ui = await pending.getInterface();
    await (ui as { cancel: () => Promise<void> }).cancel();

    const error = getError(await pending);
    expect(error.message).toBe('The user rejected this request.');
    expect(error.data?.code).toBe(-4);
  });

  it('getAddress is silent and empty for unconnected origins', async () => {
    const { request } = await install();
    expect(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    ).toRespondWith({ address: '' });
  });
});

describe('getNetwork / getNetworkDetails / setNetwork', () => {
  it('defaults to TESTNET', async () => {
    const { request } = await install();
    expect(
      await request({ origin: ORIGIN, method: 'getNetwork' }),
    ).toRespondWith({
      network: 'TESTNET',
      networkPassphrase: Networks.TESTNET,
    });
    expect(
      await request({ origin: ORIGIN, method: 'getNetworkDetails' }),
    ).toRespondWith({
      network: 'TESTNET',
      networkPassphrase: Networks.TESTNET,
      networkUrl: 'https://horizon-testnet.stellar.org',
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    });
  });

  it('requires a connected origin for setNetwork (SEP-43 code -3)', async () => {
    const { request } = await install();
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'setNetwork',
        params: { network: 'FUTURENET' },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('not connected');
  });

  it('switches networks after confirmation', async () => {
    const { request } = await install();
    await connect(request);

    const pending = request({
      origin: ORIGIN,
      method: 'setNetwork',
      params: { network: 'FUTURENET' },
    });
    const ui = await pending.getInterface();
    expect(JSON.stringify(ui.content)).toContain('FUTURENET');
    await (ui as { ok: () => Promise<void> }).ok();

    const result = getResult<{ network: string }>(await pending);
    expect(result.network).toBe('FUTURENET');

    expect(
      await request({ origin: ORIGIN, method: 'getNetwork' }),
    ).toRespondWith({
      network: 'FUTURENET',
      networkPassphrase: Networks.FUTURENET,
    });
  });

  it('rejects unknown networks with SEP-43 code -3', async () => {
    const { request } = await install();
    await connect(request);
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'setNetwork',
        params: { network: 'DOGENET' },
      }),
    );
    expect(error.data?.code).toBe(-3);
  });
});

describe('signTransaction', () => {
  it('signs a payment after approval; signature verifies against SEP-5 key', async () => {
    const { request } = await install();
    const xdr = buildPaymentXdr({ memo: 'phase-1' });

    const pending = request({
      origin: ORIGIN,
      method: 'signTransaction',
      params: { xdr, networkPassphrase: Networks.TESTNET },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    expect(content).toContain('Sign transaction');
    expect(content).toContain('Payment');
    expect(content).toContain('1.5');
    expect(content).toContain('phase-1');
    await (ui as { ok: () => Promise<void> }).ok();

    const result = getResult<{ signedTxXdr: string; signerAddress: string }>(
      await pending,
    );
    expect(result.signerAddress).toBe(SEP5_ADDRESS_0);

    const signed = TransactionBuilder.fromXDR(
      result.signedTxXdr,
      Networks.TESTNET,
    ) as Transaction;
    const [signature] = signed.signatures;
    expect(signature).toBeDefined();
    expect(
      Keypair.fromPublicKey(SEP5_ADDRESS_0).verify(
        signed.hash(),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        signature!.signature(),
      ),
    ).toBe(true);

    // An approved signature also grants the origin connection.
    expect(
      await request({ origin: ORIGIN, method: 'getAddress' }),
    ).toRespondWith({ address: SEP5_ADDRESS_0 });
  });

  it('rejection returns SEP-43 code -4', async () => {
    const { request } = await install();
    const pending = request({
      origin: ORIGIN,
      method: 'signTransaction',
      params: { xdr: buildPaymentXdr() },
    });
    const ui = await pending.getInterface();
    await (ui as { cancel: () => Promise<void> }).cancel();

    const error = getError(await pending);
    expect(error.message).toBe('The user rejected this request.');
    expect(error.data?.code).toBe(-4);
  });

  it('rejects malformed XDR with SEP-43 code -3', async () => {
    const { request } = await install();
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signTransaction',
        params: { xdr: 'not-xdr' },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('parse');
  });

  it('rejects a network passphrase mismatch with SEP-43 code -3', async () => {
    const { request } = await install();
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signTransaction',
        params: { xdr: buildPaymentXdr(), networkPassphrase: Networks.PUBLIC },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Network mismatch');
  });

  it('rejects signing for an unknown address with SEP-43 code -3', async () => {
    // Connected: selecting a non-active account needs a grant, so this
    // exercises address resolution rather than the selection gate.
    const { request } = await install(CONNECTED_STATE);
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signTransaction',
        params: {
          xdr: buildPaymentXdr(),
          address: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
        },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Unknown address');
  });

  it('refuses account selection from an origin without a grant', async () => {
    const { request } = await install();
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signTransaction',
        params: {
          xdr: buildPaymentXdr(),
          address: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
        },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('not connected');
  });

  it('frames sequence-0 transactions as unverified signature requests', async () => {
    const { request } = await install();
    const xdr = new TransactionBuilder(new Account(SEP5_ADDRESS_0, '-1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.manageData({ name: 'dapp.example auth', value: 'nonce' }),
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
    // A seq-0 tx is not asserted to be a validated SEP-10 login.
    expect(content).toContain('Signature request');
    expect(content).toContain('has not verified');
    expect(content).toContain('does not move funds');
    await (ui as { ok: () => Promise<void> }).ok();
    await pending;
  });

  it('rejects undecoded operation types before any dialog (fail closed)', async () => {
    const { request } = await install();
    const xdr = new TransactionBuilder(new Account(SEP5_ADDRESS_0, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.bumpSequence({ bumpTo: '999' }))
      .setTimeout(300)
      .build()
      .toXDR();

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signTransaction',
        params: { xdr },
      }),
    );
    expect(error.message).toContain('bumpSequence');
    expect(error.message).toContain('cannot be reviewed');
    expect(error.data?.code).toBe(-3);
  });

  it('flags accountMerge as dangerous', async () => {
    const { request } = await install();
    const xdr = new TransactionBuilder(new Account(SEP5_ADDRESS_0, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.accountMerge({
          destination:
            'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
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
    expect(content).toContain('Account merge');
    expect(content).toContain('cannot be undone');
    await (ui as { cancel: () => Promise<void> }).cancel();
    await pending;
  });
});

describe('signMessage', () => {
  it('produces a valid SEP-53 signature', async () => {
    const { request } = await install();
    const message = 'Hello, Stellar Snap!';

    const pending = request({
      origin: ORIGIN,
      method: 'signMessage',
      params: { message },
    });
    const ui = await pending.getInterface();
    expect(JSON.stringify(ui.content)).toContain('Sign message');
    await (ui as { ok: () => Promise<void> }).ok();

    const result = getResult<{ signedMessage: string; signerAddress: string }>(
      await pending,
    );
    expect(result.signerAddress).toBe(SEP5_ADDRESS_0);

    const payload = hash(
      Buffer.concat([
        Buffer.from('Stellar Signed Message:\n', 'utf8'),
        Buffer.from(message, 'utf8'),
      ]),
    );
    expect(
      Keypair.fromPublicKey(SEP5_ADDRESS_0).verify(
        payload,
        Buffer.from(result.signedMessage, 'base64'),
      ),
    ).toBe(true);
  });

  it('rejection returns SEP-43 code -4', async () => {
    const { request } = await install();
    const pending = request({
      origin: ORIGIN,
      method: 'signMessage',
      params: { message: 'nope' },
    });
    const ui = await pending.getInterface();
    await (ui as { cancel: () => Promise<void> }).cancel();

    const error = getError(await pending);
    expect(error.data?.code).toBe(-4);
  });
});

describe('fund / getBalances', () => {
  it('require a connected origin (SEP-43 code -3)', async () => {
    const { request } = await install();
    for (const method of ['fund', 'getBalances']) {
      const error = getError(await request({ origin: ORIGIN, method }));
      expect(error.data?.code).toBe(-3);
      expect(error.message).toContain('not connected');
    }
  });

  it('fund rejects an address the wallet does not hold', async () => {
    const { request } = await install();
    await connect(request);

    // Index 1 is derivable but not revealed: fund must not target it.
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'fund',
        params: {
          address: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
        },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('an account of this wallet');
  });

  it('getBalances rejects an address the wallet does not hold', async () => {
    const { request } = await install();
    await connect(request);

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'getBalances',
        params: {
          address: 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX',
        },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('an account of this wallet');
  });

  it('fund is refused on PUBLIC', async () => {
    const { request } = await install();
    await connect(request);

    const pending = request({
      origin: ORIGIN,
      method: 'setNetwork',
      params: { network: 'PUBLIC' },
    });
    const ui = await pending.getInterface();
    expect(JSON.stringify(ui.content)).toContain('Mainnet');
    await (ui as { ok: () => Promise<void> }).ok();
    await pending;

    const error = getError(await request({ origin: ORIGIN, method: 'fund' }));
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Friendbot is not available');
  });
});

describe('onHomePage', () => {
  it('shows the address and active network', async () => {
    const { onHomePage } = await install();
    const response = await onHomePage();
    const content = JSON.stringify(
      (response as { getInterface: () => { content: unknown } }).getInterface()
        .content,
    );
    expect(content).toContain('Stellar Soroban');
    expect(content).toContain(SEP5_ADDRESS_0);
    expect(content).toContain('TESTNET');
  }, 30000);
});

describe('unknown methods', () => {
  it('are rejected with method-not-found', async () => {
    const { request } = await install();
    const error = getError(await request({ origin: ORIGIN, method: 'foo' }));
    expect(error.message).toContain('Method not found');
  });
});

describe('dialog cooldown', () => {
  it('throttles an origin after three consecutive rejections', async () => {
    const { request } = await install();

    for (let i = 0; i < 3; i++) {
      const pending = request({
        origin: ORIGIN,
        method: 'signMessage',
        params: { message: 'hello' },
      });
      const ui = await pending.getInterface();
      await (ui as { cancel: () => Promise<void> }).cancel();
      expect(getError(await pending).data?.code).toBe(-4);
    }

    // The fourth attempt is refused without a dialog.
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signMessage',
        params: { message: 'hello' },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Try again in');
  }, 45000);

  it('is not reset by a dialog-free success between rejections', async () => {
    // Regression: the router used to clear the rejection count on ANY
    // successful dialog-method call, but setNetwork to the current network
    // completes without showing a dialog. A connected origin could interleave
    // that no-op between rejections and never reach the cooldown.
    const { request } = await install(CONNECTED_STATE);

    for (let i = 0; i < 2; i++) {
      const pending = request({
        origin: ORIGIN,
        method: 'signMessage',
        params: { message: 'hello' },
      });
      const ui = await pending.getInterface();
      await (ui as { cancel: () => Promise<void> }).cancel();
      expect(getError(await pending).data?.code).toBe(-4);
    }

    // Dialog-free success: the wallet is already on TESTNET, so no dialog
    // opens. This must not break the consecutive-rejection chain.
    const noop = await request({
      origin: ORIGIN,
      method: 'setNetwork',
      params: { network: 'TESTNET' },
    });
    expect(getResult<{ network: string }>(noop).network).toBe('TESTNET');

    // The third rejection still reaches the threshold.
    const third = request({
      origin: ORIGIN,
      method: 'signMessage',
      params: { message: 'hello' },
    });
    const thirdUi = await third.getInterface();
    await (thirdUi as { cancel: () => Promise<void> }).cancel();
    expect(getError(await third).data?.code).toBe(-4);

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signMessage',
        params: { message: 'hello' },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('Try again in');
  }, 60000);
});
