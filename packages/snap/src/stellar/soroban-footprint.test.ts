import { describe, expect, it } from '@jest/globals';
import {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  SorobanDataBuilder,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import type { FootprintSummary } from './soroban';
import {
  findUndisplayableFootprint,
  getSorobanData,
  MAX_FOOTPRINT_KEYS,
  summarizeFootprint,
} from './soroban';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const ISSUER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/**
 * Builds a contract-data ledger key.
 *
 * @param key - The ScVal key inside the contract's storage.
 * @returns The ledger key.
 */
function contractDataKey(
  key: xdr.ScVal = xdr.ScVal.scvLedgerKeyContractInstance(),
): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(CONTRACT).toScAddress(),
      key,
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
}

/**
 * Builds an account ledger key.
 *
 * @param address - The account address.
 * @returns The ledger key.
 */
function accountKey(address: string = SOURCE): xdr.LedgerKey {
  return xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: Keypair.fromPublicKey(address).xdrAccountId(),
    }),
  );
}

/**
 * Builds Soroban transaction data with the given footprint.
 *
 * @param readOnly - Read-only ledger keys.
 * @param readWrite - Read-write ledger keys.
 * @returns The Soroban transaction data.
 */
function sorobanData(
  readOnly: xdr.LedgerKey[],
  readWrite: xdr.LedgerKey[] = [],
): xdr.SorobanTransactionData {
  return new SorobanDataBuilder()
    .setFootprint(readOnly, readWrite)
    .setResourceFee(1000n)
    .build();
}

describe('summarizeFootprint', () => {
  it('returns null when the transaction carries no Soroban data', () => {
    expect(summarizeFootprint(null)).toBeNull();
    expect(summarizeFootprint(undefined)).toBeNull();
  });

  it('renders keys and resources for a complete footprint', () => {
    const summary = summarizeFootprint(
      sorobanData([contractDataKey()], [accountKey()]),
    );
    expect(summary).not.toBeNull();
    expect(summary?.truncated).toBe(false);
    const text = (summary as FootprintSummary).lines.join('\n');
    expect(text).toContain('Read-only (1):');
    expect(text).toContain(CONTRACT);
    expect(text).toContain('Read-write (1):');
    expect(text).toContain(SOURCE);
    expect(text).toContain('Resource fee: 1000 stroops');
  });

  it('identifies the trustline asset, not only the account', () => {
    const asset = new Asset('USDC', ISSUER);
    const key = xdr.LedgerKey.trustline(
      new xdr.LedgerKeyTrustLine({
        accountId: Keypair.fromPublicKey(SOURCE).xdrAccountId(),
        asset: asset.toTrustLineXDRObject(),
      }),
    );
    const summary = summarizeFootprint(sorobanData([key]));
    const text = (summary as FootprintSummary).lines.join('\n');
    expect(text).toContain(`trustline of ${SOURCE}`);
    expect(text).toContain(`USDC:${ISSUER}`);
    expect(summary?.truncated).toBe(false);
  });

  it('marks a footprint with more keys than the render cap truncated', () => {
    const keys = Array.from({ length: MAX_FOOTPRINT_KEYS + 1 }, () =>
      accountKey(),
    );
    const summary = summarizeFootprint(sorobanData(keys));
    expect(summary?.truncated).toBe(true);
  });

  it('propagates ScVal truncation from a contract-data key', () => {
    // A 65+-byte bytes key exceeds MAX_SCVAL_BYTES: the rendered key elides
    // bytes, so the summary must be reported incomplete.
    const bigKey = contractDataKey(xdr.ScVal.scvBytes(Buffer.alloc(100, 0xab)));
    const summary = summarizeFootprint(sorobanData([bigKey]));
    expect(summary?.truncated).toBe(true);
  });
});

describe('findUndisplayableFootprint', () => {
  it("reports 'missing' when there is no Soroban data", () => {
    expect(findUndisplayableFootprint(null)).toBe('missing');
  });

  it("reports 'truncated' when the footprint cannot be shown in full", () => {
    const keys = Array.from({ length: MAX_FOOTPRINT_KEYS + 1 }, () =>
      accountKey(),
    );
    expect(findUndisplayableFootprint(sorobanData(keys))).toBe('truncated');
  });

  it('passes a fully displayable footprint', () => {
    expect(
      findUndisplayableFootprint(sorobanData([contractDataKey()])),
    ).toBeNull();
  });
});

describe('getSorobanData', () => {
  it('returns null for a classic transaction', () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: ISSUER,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(300)
      .build();
    expect(getSorobanData(tx)).toBeNull();
  });

  it('returns the attached Soroban data for a prepared transaction', () => {
    const data = sorobanData([contractDataKey()]);
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.extendFootprintTtl({ extendTo: 1000 }))
      .setSorobanData(data)
      .setTimeout(300)
      .build();
    const extracted = getSorobanData(tx);
    expect(extracted).not.toBeNull();
    expect(summarizeFootprint(extracted)?.lines.join('\n')).toContain(CONTRACT);
  });
});

describe('Soroban data extension', () => {
  it('lists the read-write entries a transaction auto-restores', () => {
    // The extension is signed too: version 1 names read-write entries the
    // transaction restores from the archive before it runs. A section that
    // claims to show the accessed data in full must carry that list.
    const data = new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(
        1,
        new xdr.SorobanResourcesExtV0({ archivedSorobanEntries: [0, 2] }),
      ),
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({
          readOnly: [],
          readWrite: [
            contractDataKey(xdr.ScVal.scvU32(1)),
            contractDataKey(xdr.ScVal.scvU32(2)),
            contractDataKey(xdr.ScVal.scvU32(3)),
          ],
        }),
        instructions: 1,
        diskReadBytes: 2,
        writeBytes: 3,
      }),
      resourceFee: xdr.Int64.fromString('100'),
    });
    const summary = summarizeFootprint(data);
    expect(summary?.truncated).toBe(false);
    expect(summary?.lines).toContain('Auto-restore: read-write entries #1, #3');
  });

  it('says nothing about restores when the extension is empty', () => {
    const data = new xdr.SorobanTransactionData({
      ext: new xdr.SorobanTransactionDataExt(0),
      resources: new xdr.SorobanResources({
        footprint: new xdr.LedgerFootprint({
          readOnly: [contractDataKey()],
          readWrite: [],
        }),
        instructions: 1,
        diskReadBytes: 2,
        writeBytes: 3,
      }),
      resourceFee: xdr.Int64.fromString('100'),
    });
    const summary = summarizeFootprint(data);
    expect(summary?.truncated).toBe(false);
    expect(summary?.lines.join('\n')).not.toContain('Auto-restore');
  });
});
