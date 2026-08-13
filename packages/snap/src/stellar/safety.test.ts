import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

// The jest.mock call between the import groups is what the rule trips on;
// it must precede the mocked module's value imports below.
// eslint-disable-next-line import-x/order
import type { AccountChecks } from './horizon';

jest.mock('./horizon', () => ({
  getAccountChecks: jest.fn(),
}));

// eslint-disable-next-line import-x/first
import { getAccountChecks } from './horizon';
// eslint-disable-next-line import-x/first
import { collectSafetyWarnings } from './safety';
// eslint-disable-next-line import-x/first
import { NETWORKS } from '../state/networks';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const OTHER_SOURCE = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
// Deterministic, checksum-valid destination addresses.
const DESTINATIONS = [1, 2, 3, 4].map((seed) =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey(),
);
const DESTINATION = DESTINATIONS[0] as string;

const mockChecks = getAccountChecks as jest.MockedFunction<
  typeof getAccountChecks
>;

const network = NETWORKS.TESTNET;

/**
 * A funded single-signer account where the wallet key has full weight.
 *
 * @param overrides - Field overrides.
 * @returns The account checks.
 */
function fundedAccount(overrides: Partial<AccountChecks> = {}): AccountChecks {
  return {
    exists: true,
    memoRequired: false,
    signers: [{ key: SOURCE, weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
    ...overrides,
  };
}

/** Account checks for an address Horizon does not know. */
const MISSING_ACCOUNT: AccountChecks = {
  exists: false,
  memoRequired: false,
  signers: [],
  thresholds: null,
};

/**
 * Builds a per-address mock implementation at module scope, so tests carry
 * no conditional logic themselves.
 *
 * @param byAddress - Checks per address; other addresses get a funded one.
 * @returns The mock implementation.
 */
function checksByAddress(byAddress: Record<string, AccountChecks>) {
  return async (_url: string, address: string) => {
    const found = byAddress[address];
    return found ?? fundedAccount();
  };
}

/**
 * Builds a transaction from operations.
 *
 * @param operations - The operations to include.
 * @param source - The transaction source account.
 * @returns The built transaction.
 */
function buildTx(
  operations: ReturnType<typeof Operation.payment>[],
  source = SOURCE,
) {
  const builder = new TransactionBuilder(new Account(source, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  });
  for (const operation of operations) {
    builder.addOperation(operation);
  }
  return builder.setTimeout(300).build();
}

/**
 * A payment operation to the given destination.
 *
 * @param destination - The payment destination.
 * @param source - Optional per-operation source override.
 * @returns The operation.
 */
function payment(destination: string, source?: string) {
  return Operation.payment({
    destination,
    asset: Asset.native(),
    amount: '1',
    ...(source ? { source } : {}),
  });
}

describe('collectSafetyWarnings', () => {
  beforeEach(() => {
    mockChecks.mockReset();
    mockChecks.mockResolvedValue(fundedAccount());
  });

  it('discloses when destinations beyond the check budget were skipped', async () => {
    const tx = buildTx(DESTINATIONS.map((destination) => payment(destination)));
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((warning) => warning.includes('NOT checked'))).toBe(
      true,
    );
  });

  it('checks account-merge destinations for existence', async () => {
    mockChecks.mockImplementation(
      checksByAddress({ [DESTINATION]: MISSING_ACCOUNT }) as never,
    );
    const tx = buildTx([
      Operation.accountMerge({ destination: DESTINATION }) as never,
    ]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    const warning = warnings.find((entry) => entry.includes('does not exist'));
    expect(warning).toContain(DESTINATION.slice(0, 6));
  });

  it('warns about memo-required account-merge destinations', async () => {
    mockChecks.mockImplementation(
      checksByAddress({
        [DESTINATION]: fundedAccount({ memoRequired: true, signers: [] }),
      }) as never,
    );
    const tx = buildTx([
      Operation.accountMerge({ destination: DESTINATION }) as never,
    ]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((warning) => warning.includes('memo (SEP-29)'))).toBe(
      true,
    );
  });

  it('checks per-operation source overrides, not only the tx source', async () => {
    mockChecks.mockImplementation(
      checksByAddress({ [OTHER_SOURCE]: MISSING_ACCOUNT }) as never,
    );
    const tx = buildTx([payment(DESTINATION, OTHER_SOURCE) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    const warning = warnings.find((entry) => entry.includes('does not exist'));
    expect(warning).toContain(OTHER_SOURCE.slice(0, 6));
  });

  it('measures signature weight against the high threshold for account merge', async () => {
    // Weight 1 meets the medium threshold (1) but not the high one (2): the
    // old medium-only heuristic would have stayed silent here.
    mockChecks.mockResolvedValue(
      fundedAccount({ thresholds: { low: 1, med: 1, high: 2 } }),
    );
    const tx = buildTx([
      Operation.accountMerge({ destination: DESTINATION }) as never,
    ]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    const warning = warnings.find((entry) => entry.includes('high threshold'));
    expect(warning).toContain('co-signers');
  });

  it('measures signer-change setOptions against the high threshold', async () => {
    mockChecks.mockResolvedValue(
      fundedAccount({ thresholds: { low: 1, med: 1, high: 2 } }),
    );
    const tx = buildTx([
      Operation.setOptions({
        signer: { ed25519PublicKey: OTHER_SOURCE, weight: 1 },
      }) as never,
    ]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((warning) => warning.includes('high threshold'))).toBe(
      true,
    );
  });

  it('stays quiet for a simple funded payment with sufficient weight', async () => {
    const tx = buildTx([payment(DESTINATION)]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings).toStrictEqual([]);
  });
});
