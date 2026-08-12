import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';
import {
  Account,
  Address,
  Asset,
  hash,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

/** Official SEP-0005 test vector 1 (no passphrase). */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const SEP5_ADDRESS_1 =
  'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';

const ORIGIN = 'https://soroban-dapp.example';

/** The XLM Stellar Asset Contract address on testnet (deterministic). */
const XLM_SAC_TESTNET = Asset.native().contractId(Networks.TESTNET);

/**
 * Installs the snap with the SEP-5 test mnemonic.
 *
 * @returns The snaps-jest request helper.
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
 * Builds a SorobanAuthorizationEntry with address credentials.
 *
 * @param options - Entry options.
 * @param options.address - The authorizing account.
 * @param options.expiration - Signature expiration ledger.
 * @returns The entry.
 */
function buildAuthEntry({
  address = SEP5_ADDRESS_0,
  expiration = 500000,
}: { address?: string; expiration?: number } = {}) {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(XLM_SAC_TESTNET).toScAddress(),
          functionName: 'transfer',
          args: [new Address(address).toScVal()],
        }),
      ),
    subInvocations: [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(address).toScAddress(),
        nonce: new xdr.Int64(123456n),
        signatureExpirationLedger: expiration,
        signature: xdr.ScVal.scvVec([]),
      }),
    ),
    rootInvocation: invocation,
  });
}

/**
 * Decodes an auth entry's signature ScVal (vec of {public_key, signature}
 * maps) into byte records.
 *
 * @param signatureVal - The credentials signature ScVal.
 * @returns One record of named byte buffers per signature.
 */
function decodeSignatureScVal(
  signatureVal: xdr.ScVal,
): Record<string, Buffer>[] {
  return (signatureVal.vec() ?? []).map((value) => {
    const bytes: Record<string, Buffer> = {};
    for (const item of value.map() ?? []) {
      bytes[item.key().sym().toString()] = item.val().bytes();
    }
    return bytes;
  });
}

describe('signTransaction (Soroban)', () => {
  it('decodes a contract invocation and renders a simulation section', async () => {
    const { request } = await install();

    const transaction = new TransactionBuilder(
      new Account(SEP5_ADDRESS_0, '1'),
      { fee: '100', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: XLM_SAC_TESTNET,
          function: 'transfer',
          args: [
            new Address(SEP5_ADDRESS_0).toScVal(),
            new Address(SEP5_ADDRESS_1).toScVal(),
            xdr.ScVal.scvI128(
              new xdr.Int128Parts({
                hi: new xdr.Int64(0n),
                lo: new xdr.Uint64(10000000n),
              }),
            ),
          ],
        }),
      )
      .setTimeout(300)
      .build();

    const pending = request({
      origin: ORIGIN,
      method: 'signTransaction',
      params: { xdr: transaction.toXDR() },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);

    // Offline decode must always be present.
    expect(content).toContain('Contract invocation');
    expect(content).toContain(XLM_SAC_TESTNET);
    expect(content).toContain('transfer');
    // A simulation section renders in both outcomes (success or the
    // "Simulation unavailable" warning) — never silently absent.
    expect(content).toMatch(/Simulation/u);

    await (ui as { cancel: () => Promise<void> }).cancel();
    const error = getError(await pending);
    expect(error.data?.code).toBe(-4);
  }, 45000);

  it('shows embedded authorization entries and still allows review', async () => {
    const { request } = await install();

    const transaction = new TransactionBuilder(
      new Account(SEP5_ADDRESS_0, '1'),
      { fee: '100', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(
        Operation.invokeContractFunction({
          contract: XLM_SAC_TESTNET,
          function: 'transfer',
          args: [new Address(SEP5_ADDRESS_0).toScVal()],
          auth: [buildAuthEntry()],
        }),
      )
      .setTimeout(300)
      .build();

    const pending = request({
      origin: ORIGIN,
      method: 'signTransaction',
      params: { xdr: transaction.toXDR() },
    });
    // A well-formed embedded entry must not trip the fail-closed check:
    // the dialog renders with the authorization visible.
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    expect(content).toContain('Authorizations (1)');

    await (ui as { cancel: () => Promise<void> }).cancel();
    const error = getError(await pending);
    expect(error.data?.code).toBe(-4);
  }, 45000);

  it('rejects a Soroban operation mixed into a multi-op transaction', async () => {
    const { request } = await install();

    const transaction = new TransactionBuilder(
      new Account(SEP5_ADDRESS_0, '1'),
      { fee: '200', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .addOperation(
        Operation.invokeContractFunction({
          contract: XLM_SAC_TESTNET,
          function: 'transfer',
          args: [],
        }),
      )
      .setTimeout(300)
      .build();

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signTransaction',
        params: { xdr: transaction.toXDR() },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('only operation');
  });
});

describe('signAuthEntry', () => {
  it('shows the invocation tree and produces a valid signature', async () => {
    const { request } = await install();
    // Expiry 0 → the snap sets a near-future expiry from the current ledger
    // A fixed absolute ledger would now be rejected as expired since
    // testnet is far past any hardcoded value.
    const entry = buildAuthEntry({ expiration: 0 });

    const pending = request({
      origin: ORIGIN,
      method: 'signAuthEntry',
      params: { authEntry: entry.toXDR('base64') },
    });
    const ui = await pending.getInterface();
    const content = JSON.stringify(ui.content);
    expect(content).toContain('Authorize contract call');
    expect(content).toContain('transfer');
    expect(content).toContain('123456'); // nonce
    expect(content).toContain('Expires in'); // bounded lifetime shown
    await (ui as { ok: () => Promise<void> }).ok();

    const result = getResult<{
      signedAuthEntry: string;
      signerAddress: string;
    }>(await pending);
    expect(result.signerAddress).toBe(SEP5_ADDRESS_0);

    // Verify the signature over the reconstructed HashIdPreimage.
    const signed = xdr.SorobanAuthorizationEntry.fromXDR(
      result.signedAuthEntry,
      'base64',
    );
    const credentials = signed.credentials().address();
    // The snap set a positive, near-future expiration ledger.
    expect(credentials.signatureExpirationLedger()).toBeGreaterThan(0);

    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET, 'utf8')),
        nonce: credentials.nonce(),
        signatureExpirationLedger: credentials.signatureExpirationLedger(),
        invocation: signed.rootInvocation(),
      }),
    );
    const payload = hash(preimage.toXDR());

    const signature = decodeSignatureScVal(credentials.signature())[0]
      ?.signature;
    expect(signature).toBeDefined();
    expect(
      Keypair.fromPublicKey(SEP5_ADDRESS_0).verify(
        payload,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        signature!,
      ),
    ).toBe(true);
  });

  it('rejects source-account credential entries with SEP-43 code -3', async () => {
    const { request } = await install();
    const entry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
      rootInvocation: buildAuthEntry().rootInvocation(),
    });

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signAuthEntry',
        params: { authEntry: entry.toXDR('base64') },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('source-account');
  });

  it('rejects entries naming a different account with SEP-43 code -3', async () => {
    const { request } = await install();
    const entry = buildAuthEntry({ address: SEP5_ADDRESS_1 });

    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signAuthEntry',
        params: { authEntry: entry.toXDR('base64') },
      }),
    );
    expect(error.data?.code).toBe(-3);
    expect(error.message).toContain('different account');
  });

  it('rejects malformed entry XDR with SEP-43 code -3', async () => {
    const { request } = await install();
    const error = getError(
      await request({
        origin: ORIGIN,
        method: 'signAuthEntry',
        params: { authEntry: 'not-xdr' },
      }),
    );
    expect(error.data?.code).toBe(-3);
  });

  it('rejection returns SEP-43 code -4', async () => {
    const { request } = await install();
    const pending = request({
      origin: ORIGIN,
      // Expiry 0 → snap sets a valid near-future expiry so the dialog shows.
      params: { authEntry: buildAuthEntry({ expiration: 0 }).toXDR('base64') },
      method: 'signAuthEntry',
    });
    const ui = await pending.getInterface();
    await (ui as { cancel: () => Promise<void> }).cancel();

    const error = getError(await pending);
    expect(error.message).toBe('The user rejected this request.');
    expect(error.data?.code).toBe(-4);
  });
});
