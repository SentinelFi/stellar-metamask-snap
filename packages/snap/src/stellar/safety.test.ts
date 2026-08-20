import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
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
import { collectFeeSourceWarnings, collectSafetyWarnings } from './safety';
// eslint-disable-next-line import-x/first
import {
  MAX_PREDIALOG_LOOKUPS,
  MAX_PREDIALOG_UNCONNECTED,
  resetRequestLimits,
  takePredialogBudget,
} from '../rpc/limiter';
// eslint-disable-next-line import-x/first
import { NETWORKS } from '../state/networks';

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const OTHER_SOURCE = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
// Deterministic, checksum-valid destination addresses.
const DESTINATIONS = [1, 2, 3, 4].map((seed) =>
  Keypair.fromRawEd25519Seed(Buffer.alloc(32, seed)).publicKey(),
);
const DESTINATION = DESTINATIONS[0] as string;
/** A muxed (`M...`) address: Horizon's accounts endpoint cannot look it up. */
const MUXED_DESTINATION = new MuxedAccount(
  new Account(DESTINATION, '0'),
  '1',
).accountId();

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
    // The safety lookups draw on the global pre-dialog budget, which is
    // module state shared by every test in this file.
    resetRequestLimits();
  });

  it('discloses muxed destinations rather than skipping them silently', async () => {
    // Regression: `M...` addresses were filtered out before the lookup and
    // never mentioned, so a transaction paying only muxed destinations
    // produced zero warnings, which is indistinguishable from one that
    // passed every check. Muxed destinations are common in exchange and
    // custodial flows, exactly where the SEP-29 memo warning matters.
    const tx = buildTx([payment(MUXED_DESTINATION) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    const warning = warnings.find((entry) => entry.includes('muxed'));
    expect(warning).toContain('NOT checked');
  });

  it('discloses a muxed transaction source', async () => {
    // `Account` rejects M-addresses, so the muxed source has to come from a
    // MuxedAccount: this is the shape a real muxed-source envelope has.
    const tx = new TransactionBuilder(
      new MuxedAccount(new Account(DESTINATION, '1'), '5'),
      { fee: '100', networkPassphrase: Networks.TESTNET },
    )
      .addOperation(payment(OTHER_SOURCE) as never)
      .setTimeout(300)
      .build();
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((entry) => entry.includes('muxed'))).toBe(true);
  });

  it('stays silent about muxed accounts when there are none', async () => {
    const tx = buildTx([payment(DESTINATION) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((entry) => entry.includes('muxed'))).toBe(false);
  });

  it('discloses unchecked accounts when Horizon lookups fail', async () => {
    // Regression: a Horizon error status, timeout, or malformed body made
    // `getAccountChecks` return null, and the consumer skipped the account
    // without a word, so an outage produced zero warnings, which reads like
    // a transaction that was checked and found clean.
    mockChecks.mockResolvedValue(null);
    const tx = buildTx([payment(DESTINATION) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    const skipped = warnings.filter((entry) =>
      entry.startsWith('Safety checks were skipped'),
    );
    expect(skipped).toHaveLength(1);
    // The destination and the source: both lookups failed.
    expect(skipped[0]).toContain('2 account(s)');
    expect(skipped[0]).toContain('NOT checked');
  });

  it('counts only the accounts whose lookup failed', async () => {
    mockChecks.mockReset();
    mockChecks.mockResolvedValueOnce(null).mockResolvedValue(fundedAccount());
    const tx = buildTx([payment(DESTINATION) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    const skipped = warnings.filter((entry) =>
      entry.startsWith('Safety checks were skipped'),
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('1 account(s)');
  });

  it('discloses skipped checks when the global lookup budget is exhausted', async () => {
    // Denial must surface as a visible caution, never as silence: an
    // attacker who could drain the budget would otherwise be suppressing a
    // legitimate transaction's safety warnings.
    for (let index = 0; index < MAX_PREDIALOG_LOOKUPS; index += 1) {
      takePredialogBudget(true);
    }
    const tx = buildTx([payment(DESTINATION) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((entry) => entry.includes('NOT checked'))).toBe(true);
    // Budget denial must not spend network lookups it was refused.
    expect(mockChecks).not.toHaveBeenCalled();
  });

  it('still checks a connected origin after cold callers drain their share', async () => {
    // Regression: the pre-dialog budget was one pool claimed before any
    // dialog opens, so a site rotating subdomains could empty it with no user
    // interaction and force every other site's dialog into the "checks were
    // skipped" state. A connected origin now draws on a share the cold
    // surface cannot reach.
    for (let index = 0; index < MAX_PREDIALOG_UNCONNECTED; index += 1) {
      takePredialogBudget(false);
    }
    mockChecks.mockImplementation(
      checksByAddress({ [DESTINATION]: MISSING_ACCOUNT }) as never,
    );
    const tx = buildTx([payment(DESTINATION) as never]);

    const cold = await collectSafetyWarnings(tx, network, SOURCE);
    expect(cold.some((entry) => entry.includes('NOT checked'))).toBe(true);

    const granted = await collectSafetyWarnings(tx, network, SOURCE, {
      connected: true,
    });
    // The real warning survives for the connected site.
    expect(granted.some((entry) => entry.includes('does not exist'))).toBe(
      true,
    );
    expect(granted.some((entry) => entry.includes('NOT checked'))).toBe(false);
  });

  it('treats an omitted connection flag as unconnected', async () => {
    // Fail-safe default: a caller that forgets to pass the flag must land in
    // the cold share, never silently reach the reserved one.
    for (let index = 0; index < MAX_PREDIALOG_UNCONNECTED; index += 1) {
      takePredialogBudget(false);
    }
    const tx = buildTx([payment(DESTINATION) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE);
    expect(warnings.some((entry) => entry.includes('NOT checked'))).toBe(true);
    expect(mockChecks).not.toHaveBeenCalled();
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

  it('skips source weight checks when the signer does not sign the sources', async () => {
    // Fee-bump case: the wallet signs only the outer envelope, so an
    // inner-source threshold the wallet key cannot meet is not its problem
    // and the old warning here was spurious.
    mockChecks.mockResolvedValue(
      fundedAccount({ thresholds: { low: 1, med: 2, high: 2 } }),
    );
    const tx = buildTx([payment(DESTINATION)]);
    const withWeights = await collectSafetyWarnings(tx, network, SOURCE);
    const withoutWeights = await collectSafetyWarnings(tx, network, SOURCE, {
      signerSignsSources: false,
    });
    expect(withWeights.some((entry) => entry.includes('co-signers'))).toBe(
      true,
    );
    expect(withoutWeights).toStrictEqual([]);
  });

  it('still reports unfunded sources when weight checks are skipped', async () => {
    mockChecks.mockImplementation(
      checksByAddress({ [OTHER_SOURCE]: MISSING_ACCOUNT }) as never,
    );
    const tx = buildTx([payment(DESTINATION, OTHER_SOURCE) as never]);
    const warnings = await collectSafetyWarnings(tx, network, SOURCE, {
      signerSignsSources: false,
    });
    const warning = warnings.find((entry) => entry.includes('does not exist'));
    expect(warning).toContain(OTHER_SOURCE.slice(0, 6));
  });
});

describe('collectFeeSourceWarnings', () => {
  beforeEach(() => {
    mockChecks.mockReset();
    mockChecks.mockResolvedValue(fundedAccount());
    resetRequestLimits();
  });

  it('warns when the fee source does not exist', async () => {
    mockChecks.mockResolvedValue(MISSING_ACCOUNT);
    const warnings = await collectFeeSourceWarnings(SOURCE, network, SOURCE);
    const warning = warnings.find((entry) => entry.includes('does not exist'));
    expect(warning).toContain('Fee source');
    expect(warning).toContain(SOURCE.slice(0, 6));
  });

  it('measures the wallet weight against the low threshold', async () => {
    // A fee-bump signature must meet the fee source's low threshold; weight
    // 1 is below a low threshold of 2.
    mockChecks.mockResolvedValue(
      fundedAccount({ thresholds: { low: 2, med: 2, high: 2 } }),
    );
    const warnings = await collectFeeSourceWarnings(SOURCE, network, SOURCE);
    const warning = warnings.find((entry) => entry.includes('low threshold'));
    expect(warning).toContain('co-signers');
  });

  it('stays quiet for a funded fee source with sufficient weight', async () => {
    const warnings = await collectFeeSourceWarnings(SOURCE, network, SOURCE);
    expect(warnings).toStrictEqual([]);
  });

  it('discloses a skipped muxed fee source instead of staying silent', async () => {
    // Regression: this returned no warnings at all. The fee source is the
    // account the wallet's signature actually authorizes, so silence here is
    // the most misleading silence in the module: it is indistinguishable
    // from a lookup that ran and passed.
    const warnings = await collectFeeSourceWarnings(
      MUXED_DESTINATION,
      network,
      SOURCE,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('muxed');
    expect(warnings[0]).toContain('NOT checked');
    expect(mockChecks).not.toHaveBeenCalled();
  });

  it('discloses a skipped fee source when the global budget is exhausted', async () => {
    for (let index = 0; index < MAX_PREDIALOG_LOOKUPS; index += 1) {
      takePredialogBudget(true);
    }
    const warnings = await collectFeeSourceWarnings(SOURCE, network, SOURCE);
    expect(warnings.some((entry) => entry.includes('NOT checked'))).toBe(true);
    expect(mockChecks).not.toHaveBeenCalled();
  });

  it('discloses an unchecked fee source when Horizon is unreachable', async () => {
    // A failed lookup is a check that did not run, not one that passed, and
    // the fee source is the account the wallet's signature authorizes.
    mockChecks.mockResolvedValue(null);
    const warnings = await collectFeeSourceWarnings(SOURCE, network, SOURCE);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Safety checks were skipped');
    expect(warnings[0]).toContain('NOT checked');
  });

  it('still checks the fee source for a connected origin under cold pressure', async () => {
    // The fee source is the account the wallet's signature actually
    // authorizes on a fee bump, so it is the check least acceptable to lose
    // to another site's traffic.
    for (let index = 0; index < MAX_PREDIALOG_UNCONNECTED; index += 1) {
      takePredialogBudget(false);
    }
    mockChecks.mockResolvedValue(MISSING_ACCOUNT);

    const cold = await collectFeeSourceWarnings(SOURCE, network, SOURCE);
    expect(cold.some((entry) => entry.includes('NOT checked'))).toBe(true);

    const granted = await collectFeeSourceWarnings(
      SOURCE,
      network,
      SOURCE,
      true,
    );
    expect(granted.some((entry) => entry.includes('does not exist'))).toBe(
      true,
    );
  });
});
