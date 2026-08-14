import type { GenericSnapElement, JSXElement } from '@metamask/snaps-sdk/jsx';
import {
  Banner,
  Bold,
  Box,
  Copyable,
  Divider,
  Heading,
  Row,
  Section,
  Text,
} from '@metamask/snaps-sdk/jsx';
import type {
  FeeBumpTransaction,
  OperationRecord,
  Asset,
} from '@stellar/stellar-sdk';
import { SignerKey, Transaction } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import { ConnectionGrantNotice, originCautionBanner } from './dialogs';
import {
  bytesToDisplay,
  isLossyInline,
  displayOrigin,
  escapeHiddenCharacters,
  formatAsset,
  formatAssetFull,
  formatLiquidityPool,
  formatMemo,
  sanitizeInlineText,
  stroopsToXlm,
} from './format';
import type { NetworkName } from '../state/networks';
import type { SimulationSummary } from '../stellar/soroban';
import {
  decodeHostFunction,
  formatSymbolName,
  getSorobanData,
  summarizeAuthEntries,
  summarizeFootprint,
} from '../stellar/soroban';

/**
 * Operation types the review dialog can decode faithfully. Transactions
 * containing anything else are rejected before the dialog is shown (fail
 * closed): a warning banner over raw XDR is not a usable review mechanism.
 */
export const SUPPORTED_OPERATION_TYPES = new Set([
  'payment',
  'createAccount',
  'changeTrust',
  'pathPaymentStrictSend',
  'pathPaymentStrictReceive',
  'manageData',
  'setOptions',
  'accountMerge',
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
]);

/**
 * Warns when the inline preview of any of the given untrusted strings
 * differs from the value itself.
 *
 * This covers invisible and direction-altering characters, and equally the
 * ordinary tabs and line breaks that inline rendering collapses: in both
 * cases the preview reads differently from the bytes being signed, and the
 * user has no way to tell without being told.
 *
 * @param values - Untrusted strings that are rendered inline.
 * @returns A warning banner, or null when every preview is exact.
 */
function lossyTextBanner(
  values: (string | undefined)[],
): GenericSnapElement | null {
  if (!values.some((value) => value !== undefined && isLossyInline(value))) {
    return null;
  }
  return (
    <Banner title="Display differs from signed text" severity="warning">
      <Text>
        A text field here contains characters that this preview cannot show
        exactly, such as line breaks, tabs, or invisible marks. They are
        collapsed above but remain in what you sign. Compare the exact value
        shown below it.
      </Text>
    </Banner>
  );
}

/**
 * Full, lossless identity of a non-native asset for copy/inspection,
 * complementing the shortened inline form.
 *
 * @param label - The display label.
 * @param asset - The asset to render.
 * @returns The detail block, or null for native/pool assets.
 */
function renderAssetFull(
  label: string,
  asset: unknown,
): GenericSnapElement | null {
  const full = formatAssetFull(asset);
  if (!full) {
    return null;
  }
  return (
    <Box>
      <Text>{label}</Text>
      <Copyable value={full} />
    </Box>
  );
}

/**
 * Renders a path payment's intermediate hop assets with full identities.
 * The hops are part of the signed bytes and constrain execution, so they
 * must be reviewable.
 *
 * @param path - The operation's path assets.
 * @returns The path block, or null when the path is empty.
 */
function renderPathAssets(
  path: Asset[] | undefined,
): GenericSnapElement | null {
  if (!path || path.length === 0) {
    return null;
  }
  const hops = path.map(
    (asset, index) =>
      `${index + 1}. ${
        asset.isNative() ? 'XLM (native)' : (formatAssetFull(asset) ?? '?')
      }`,
  );
  return (
    <Box>
      <Text>{`Path (${path.length} hop${path.length === 1 ? '' : 's'})`}</Text>
      <Copyable value={hops.join('\n')} />
    </Box>
  );
}

/** The concrete key variants a `setOptions` signer can carry. */
type OperationSigner = {
  ed25519PublicKey?: string;
  sha256Hash?: unknown;
  preAuthTx?: unknown;
  ed25519SignedPayload?: string;
};

/**
 * Describes a `setOptions` signer key by its concrete type, so a signer
 * change shows *which* key is added/removed, not just its weight.
 *
 * @param signer - The operation's signer object.
 * @returns A display string identifying the signer key.
 */
function describeSigner(signer: OperationSigner): string {
  if (signer.ed25519PublicKey) {
    return signer.ed25519PublicKey;
  }
  if (signer.ed25519SignedPayload) {
    return `signed-payload:${signer.ed25519SignedPayload}`;
  }
  if (signer.sha256Hash) {
    return `hash(x):${Buffer.from(signer.sha256Hash as Buffer).toString('hex')}`;
  }
  if (signer.preAuthTx) {
    return `pre-auth-tx:${Buffer.from(signer.preAuthTx as Buffer).toString('hex')}`;
  }
  return 'unknown signer type';
}

/**
 * A per-operation source-account row, shown when an operation overrides the
 * transaction source so a hidden alternate source is visible.
 *
 * @param operation - The parsed operation.
 * @returns A source row, or null when the operation uses the tx source.
 */
function renderOperationSource(
  operation: OperationRecord,
): GenericSnapElement | null {
  if (!operation.source) {
    return null;
  }
  return (
    <Box>
      <Text>Operation source</Text>
      <Copyable value={operation.source} />
    </Box>
  );
}

/**
 * Renders one decoded operation as a titled section. Unknown operation types
 * get an explicit warning instead of a silent skip — the raw XDR at the
 * bottom of the dialog is then the only source of truth.
 *
 * @param operation - The parsed operation.
 * @param index - Zero-based position in the transaction.
 * @returns The operation section.
 */
function renderOperationBody(
  operation: OperationRecord,
  index: number,
): GenericSnapElement {
  const title = `Operation ${index + 1}`;

  // Deliberately non-exhaustive: only the allowlisted operation types are
  // decoded; everything else falls through to the explicit warning below.
  // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
  switch (operation.type) {
    case 'payment':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Payment`}</Bold>
          </Text>
          <Row label="Amount">
            <Text>{`${operation.amount} ${formatAsset(operation.asset)}`}</Text>
          </Row>
          {renderAssetFull('Asset', operation.asset)}
          <Text>Destination</Text>
          <Copyable value={operation.destination} />
        </Section>
      );

    case 'createAccount':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Create account`}</Bold>
          </Text>
          <Row label="Starting balance">
            <Text>{`${operation.startingBalance} XLM`}</Text>
          </Row>
          <Text>New account</Text>
          <Copyable value={operation.destination} />
        </Section>
      );

    case 'changeTrust': {
      const removing = operation.limit === '0';
      const poolLines = formatLiquidityPool(operation.line);
      return (
        <Section>
          <Text>
            <Bold>
              {`${title}: ${removing ? 'Remove trustline' : 'Change trustline'}`}
            </Bold>
          </Text>
          <Row label="Asset">
            <Text>{formatAsset(operation.line)}</Text>
          </Row>
          {renderAssetFull('Asset (full)', operation.line)}
          {/* A pool trustline is defined by its constituents, fee, and pool
              ID; without them the row above cannot distinguish one pool from
              another. */}
          {poolLines === null ? null : (
            <Box>
              <Text>Liquidity pool (full)</Text>
              <Copyable value={poolLines.join('\n')} />
            </Box>
          )}
          <Row label="Limit" variant={removing ? 'warning' : 'default'}>
            <Text>{removing ? 'Remove (0)' : operation.limit}</Text>
          </Row>
        </Section>
      );
    }

    case 'pathPaymentStrictSend':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Path payment (strict send)`}</Bold>
          </Text>
          <Row label="Send">
            <Text>
              {`${operation.sendAmount} ${formatAsset(operation.sendAsset)}`}
            </Text>
          </Row>
          <Row label="Minimum received">
            <Text>
              {`${operation.destMin} ${formatAsset(operation.destAsset)}`}
            </Text>
          </Row>
          {renderAssetFull('Send asset', operation.sendAsset)}
          {renderAssetFull('Receive asset', operation.destAsset)}
          {renderPathAssets(operation.path)}
          <Text>Destination</Text>
          <Copyable value={operation.destination} />
        </Section>
      );

    case 'pathPaymentStrictReceive':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Path payment (strict receive)`}</Bold>
          </Text>
          <Row label="Maximum sent">
            <Text>
              {`${operation.sendMax} ${formatAsset(operation.sendAsset)}`}
            </Text>
          </Row>
          <Row label="Received">
            <Text>
              {`${operation.destAmount} ${formatAsset(operation.destAsset)}`}
            </Text>
          </Row>
          {renderAssetFull('Send asset', operation.sendAsset)}
          {renderAssetFull('Receive asset', operation.destAsset)}
          {renderPathAssets(operation.path)}
          <Text>Destination</Text>
          <Copyable value={operation.destination} />
        </Section>
      );

    case 'manageData': {
      // The value is raw bytes: render it losslessly (clean UTF-8 text or
      // full hex) in a Copyable so display and signed bytes cannot diverge.
      const value =
        operation.value === undefined
          ? undefined
          : bytesToDisplay(Buffer.from(operation.value));
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Manage data`}</Bold>
          </Text>
          {lossyTextBanner([operation.name])}
          <Text>Key</Text>
          <Copyable value={operation.name} />
          {isLossyInline(operation.name) ? (
            // The raw key above keeps hidden characters hidden; this view
            // makes every such code point visible.
            <Box>
              <Text>Key (exact, special characters escaped)</Text>
              <Copyable value={escapeHiddenCharacters(operation.name)} />
            </Box>
          ) : null}
          {value === undefined ? (
            <Row label="Value">
              <Text>Delete entry</Text>
            </Row>
          ) : (
            <Box>
              <Text>Value</Text>
              <Copyable value={value} />
            </Box>
          )}
        </Section>
      );
    }

    case 'setOptions': {
      const rows: GenericSnapElement[] = [];
      if (operation.signer) {
        // Show the signer key itself, not only its weight — adding or
        // removing a signer changes who controls the account.
        rows.push(
          <Row label="Signer weight" variant="critical">
            <Text>{String(operation.signer.weight ?? '?')}</Text>
          </Row>,
        );
        rows.push(
          <Text>Signer key</Text>,
          <Copyable value={describeSigner(operation.signer)} />,
        );
      }
      if (operation.masterWeight !== undefined) {
        rows.push(
          <Row label="Master key weight" variant="critical">
            <Text>{String(operation.masterWeight)}</Text>
          </Row>,
        );
      }
      if (operation.inflationDest !== undefined) {
        // Inflation payouts are retired, but the destination is still a
        // signed field of the operation and must not be silently dropped
        // from what the user is approving.
        rows.push(
          <Text>Inflation destination</Text>,
          <Copyable value={String(operation.inflationDest)} />,
        );
      }
      for (const [label, value] of [
        ['Low threshold', operation.lowThreshold],
        ['Medium threshold', operation.medThreshold],
        ['High threshold', operation.highThreshold],
        ['Home domain', operation.homeDomain],
        ['Set flags', operation.setFlags],
        ['Clear flags', operation.clearFlags],
      ] as const) {
        if (value !== undefined) {
          rows.push(
            <Row label={label} variant="warning">
              <Text>
                {label === 'Home domain'
                  ? sanitizeInlineText(String(value))
                  : String(value)}
              </Text>
            </Row>,
          );
        }
      }
      return (
        <Section>
          <Banner title={`${title}: Set options`} severity="warning">
            <Text>
              This operation changes account settings and can affect who
              controls the account. Review carefully.
            </Text>
          </Banner>
          {lossyTextBanner([operation.homeDomain])}
          {rows}
          {operation.homeDomain !== undefined &&
          isLossyInline(operation.homeDomain) ? (
            // The row above is a sanitized preview; show the exact signed
            // value with hidden characters escaped visibly.
            <Box>
              <Text>Home domain (exact, special characters escaped)</Text>
              <Copyable value={escapeHiddenCharacters(operation.homeDomain)} />
            </Box>
          ) : null}
        </Section>
      );
    }

    case 'accountMerge':
      return (
        <Section>
          <Banner title={`${title}: Account merge`} severity="danger">
            <Text>
              This deletes the source account and sends its entire XLM balance
              to the destination. This cannot be undone.
            </Text>
          </Banner>
          <Text>Destination</Text>
          <Copyable value={String(operation.destination)} />
        </Section>
      );

    case 'invokeHostFunction': {
      const decoded = decodeHostFunction(operation.func);
      if (decoded.kind === 'unknown') {
        // Unreachable in practice: signTransaction rejects unknown host
        // function types before the dialog is built. Kept as defense.
        return (
          <Section>
            <Banner title={`${title}: Unknown host function`} severity="danger">
              <Text>
                This host function cannot be decoded by the snap and cannot be
                reviewed faithfully.
              </Text>
            </Banner>
          </Section>
        );
      }
      if (decoded.kind !== 'invoke') {
        return (
          <Section>
            <Banner
              title={`${title}: ${
                decoded.kind === 'uploadWasm'
                  ? 'Upload contract code'
                  : 'Create contract'
              }`}
              severity="warning"
            >
              <Text>
                This deploys contract code or a new contract instance. Review
                the details and the raw transaction XDR below.
              </Text>
            </Banner>
            {(decoded.details ?? []).length > 0 ? (
              <Copyable value={(decoded.details ?? []).join('\n')} />
            ) : null}
          </Section>
        );
      }
      const authCount = operation.auth?.length ?? 0;
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Contract invocation`}</Bold>
          </Text>
          <Text>Contract</Text>
          <Copyable value={decoded.contract ?? ''} />
          {/* Lossless: a plain identifier renders bare; anything else is
              quoted with hidden characters escaped visibly, exactly as in
              the authorization-entry renderer. */}
          <Row label="Function">
            <Text>{formatSymbolName(decoded.functionName ?? '')}</Text>
          </Row>
          {decoded.args.length > 0 ? (
            <Text>Arguments</Text>
          ) : (
            <Row label="Arguments">
              <Text>none</Text>
            </Row>
          )}
          {decoded.args.length > 0 ? (
            <Copyable value={decoded.args.join('\n')} />
          ) : null}
          {authCount > 0 ? (
            <Text>{`Authorizations (${authCount})`}</Text>
          ) : null}
          {authCount > 0 ? (
            <Copyable
              value={summarizeAuthEntries(operation.auth ?? []).join('\n\n')}
            />
          ) : null}
        </Section>
      );
    }

    case 'extendFootprintTtl':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Extend contract data lifetime`}</Bold>
          </Text>
          <Row label="Extend to">
            <Text>{`${operation.extendTo} ledgers`}</Text>
          </Row>
        </Section>
      );

    case 'restoreFootprint':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Restore archived contract data`}</Bold>
          </Text>
          <Text>
            Restores expired ledger entries so a contract can use them again.
          </Text>
        </Section>
      );

    default:
      return (
        <Section>
          <Banner title={`${title}: ${operation.type}`} severity="warning">
            <Text>
              This operation type is not decoded by the snap. Review the raw
              transaction XDR below before approving.
            </Text>
          </Banner>
        </Section>
      );
  }
}

/**
 * Renders a decoded operation, appending its source-account row when the
 * operation overrides the transaction source.
 *
 * @param operation - The parsed operation.
 * @param index - Zero-based position in the transaction.
 * @returns The operation section.
 */
function renderOperation(
  operation: OperationRecord,
  index: number,
): GenericSnapElement {
  const body = renderOperationBody(operation, index);
  const source = renderOperationSource(operation);
  if (!source) {
    return body;
  }
  return (
    <Box>
      {body}
      <Section>{source}</Section>
    </Box>
  );
}

/**
 * Header rows shared by regular transactions.
 *
 * @param tx - The parsed transaction.
 * @returns Summary section.
 */
/**
 * Renders a unix-seconds time bound with a readable UTC form when parseable.
 *
 * @param value - The bound as a decimal string ('0' = unset).
 * @returns The display string, or null when unset.
 */
function formatTimeBound(value: string | undefined): string | null {
  if (value === undefined || value === '0') {
    return null;
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return value;
  }
  try {
    return `${value} (${new Date(seconds * 1000).toISOString()})`;
  } catch {
    return value;
  }
}

/**
 * Whether the transaction carries an upper time bound at all. Stellar encodes
 * "no bound" as `0`, and an envelope may carry no `timeBounds` whatsoever;
 * both mean the signature stays submittable indefinitely.
 *
 * @param tx - The parsed transaction.
 * @returns True when a real expiry is set.
 */
function hasUpperTimeBound(tx: Transaction): boolean {
  const maxTime = tx.timeBounds?.maxTime;
  return maxTime !== undefined && maxTime !== '0';
}

/**
 * Rows for the transaction's preconditions (time/ledger bounds, minimum
 * sequence constraints, extra signers). These bound when and how the
 * signature is usable, so they are part of a faithful review.
 *
 * @param tx - The parsed transaction.
 * @returns Precondition elements (possibly empty).
 */
function renderPreconditions(tx: Transaction): GenericSnapElement[] {
  const rows: GenericSnapElement[] = [];

  const minTime = formatTimeBound(tx.timeBounds?.minTime);
  if (minTime) {
    rows.push(
      <Row label="Valid after">
        <Text>{minTime}</Text>
      </Row>,
    );
  }
  // The "Valid until" row is always rendered, including when there is no
  // bound at all. An unset maxTime means the signature stays submittable
  // forever, which is the more dangerous case, yet omitting the row rendered
  // it identically to a transaction expiring in five minutes: in both the row
  // was simply absent, and absence reads as "not applicable here" rather than
  // "this never expires". The dapp holds the signed envelope on the default
  // (non-submitting) path, so unbounded validity is its choice of when.
  const maxTime = formatTimeBound(tx.timeBounds?.maxTime);
  rows.push(
    maxTime ? (
      <Row label="Valid until">
        <Text>{maxTime}</Text>
      </Row>
    ) : (
      <Row label="Valid until" variant="warning">
        <Text>No expiry: submittable at any future time</Text>
      </Row>
    ),
  );

  if (tx.ledgerBounds) {
    const { minLedger, maxLedger } = tx.ledgerBounds;
    if (minLedger !== 0 || maxLedger !== 0) {
      rows.push(
        <Row label="Ledger bounds">
          <Text>{`${minLedger} to ${maxLedger === 0 ? 'unbounded' : maxLedger}`}</Text>
        </Row>,
      );
    }
  }

  if (tx.minAccountSequence !== undefined) {
    rows.push(
      <Row label="Min account sequence">
        <Text>{String(tx.minAccountSequence)}</Text>
      </Row>,
    );
  }
  if (tx.minAccountSequenceAge !== undefined && tx.minAccountSequenceAge > 0n) {
    rows.push(
      <Row label="Min sequence age">
        <Text>{`${tx.minAccountSequenceAge.toString()} s`}</Text>
      </Row>,
    );
  }
  if (
    tx.minAccountSequenceLedgerGap !== undefined &&
    tx.minAccountSequenceLedgerGap > 0
  ) {
    rows.push(
      <Row label="Min sequence ledger gap">
        <Text>{String(tx.minAccountSequenceLedgerGap)}</Text>
      </Row>,
    );
  }

  const extraSigners = tx.extraSigners ?? [];
  if (extraSigners.length > 0) {
    const encoded = extraSigners.map((signer) => {
      try {
        return SignerKey.encodeSignerKey(signer);
      } catch {
        return '(unrenderable signer key — review the raw XDR)';
      }
    });
    rows.push(
      <Box>
        <Text>Extra required signers</Text>
        <Copyable value={encoded.join('\n')} />
      </Box>,
    );
  }

  return rows;
}

/**
 * Header rows shared by regular transactions: full source, fee, sequence,
 * memo (with a hidden-character warning for text memos), and preconditions.
 *
 * @param tx - The parsed transaction.
 * @returns The summary section.
 */
function renderSummary(tx: Transaction): GenericSnapElement {
  const memo = formatMemo(tx.memo);
  const rawMemoText =
    tx.memo.type === 'text' ? tx.memo.value?.toString() : undefined;
  // A sequence-0 envelope can never execute, so its (absent) expiry is moot:
  // the banner would be noise on a login challenge, whose own branch already
  // explains that it cannot be submitted at all.
  const unbounded = tx.sequence !== '0' && !hasUpperTimeBound(tx);
  return (
    <Section>
      {lossyTextBanner([rawMemoText])}
      {unbounded ? (
        <Banner title="This signature never expires" severity="warning">
          <Text>
            This transaction sets no expiry time, so once signed it can be
            submitted to the network at any point in the future, not just now.
            Only approve if you intend the site to be able to use it later.
          </Text>
        </Banner>
      ) : null}
      <Text>Source</Text>
      <Copyable value={tx.source} />
      <Row label="Max fee">
        <Text>{`${stroopsToXlm(tx.fee)} XLM`}</Text>
      </Row>
      <Row label="Sequence">
        <Text>{tx.sequence}</Text>
      </Row>
      {memo ? (
        <Row label={memo[0]}>
          <Text>{memo[1]}</Text>
        </Row>
      ) : null}
      {rawMemoText !== undefined && isLossyInline(rawMemoText) ? (
        // The inline row above is a sanitized preview; give the user the
        // exact signed text with hidden characters escaped visibly.
        <Box>
          <Text>Memo (exact, special characters escaped)</Text>
          <Copyable value={escapeHiddenCharacters(rawMemoText)} />
        </Box>
      ) : null}
      {renderPreconditions(tx)}
    </Section>
  );
}

/**
 * Renders the transaction's Soroban footprint: the ledger entries it may
 * read and write, and the resources it commits to.
 *
 * The footprint bounds the transaction's entire state access and is part of
 * what is signed, so a dialog that omits it lets the user approve a scope
 * they cannot see. This applies to every Soroban transaction, not only the
 * TTL and restore operations whose whole content is their footprint.
 *
 * @param tx - The transaction carrying the operations.
 * @returns The footprint section, or null when there is no footprint.
 */
function renderFootprint(
  tx: Transaction | FeeBumpTransaction,
): GenericSnapElement | null {
  const inner = tx instanceof Transaction ? tx : tx.innerTransaction;
  const summary = summarizeFootprint(getSorobanData(inner));
  if (!summary) {
    return null;
  }
  return (
    <Section>
      <Text>
        <Bold>Contract data accessed</Bold>
      </Text>
      {summary.truncated ? (
        <Banner title="Footprint not shown in full" severity="warning">
          <Text>
            This transaction touches more ledger entries than can be listed
            here. Review the raw transaction XDR below.
          </Text>
        </Banner>
      ) : null}
      <Copyable value={summary.lines.join('\n')} />
    </Section>
  );
}

/**
 * Renders the display-verification simulation results for a Soroban
 * transaction.
 *
 * @param simulation - The simulation summary, or null when not simulated.
 * @returns The simulation section, or null.
 */
function renderSimulation(
  simulation: SimulationSummary | null,
): GenericSnapElement | null {
  if (!simulation) {
    return null;
  }

  if (!simulation.ok) {
    return (
      <Section>
        <Banner title="Simulation unavailable" severity="warning">
          <Text>
            The snap could not verify this contract call by simulation. Only
            approve if you trust the requesting site.
          </Text>
        </Banner>
        <Row label="Reason">
          {/* Endpoint-controlled text: sanitize so a hostile RPC cannot
              forge dialog lines or reorder the warning. */}
          <Text>{sanitizeInlineText(simulation.error)}</Text>
        </Row>
      </Section>
    );
  }

  return (
    <Section>
      <Text>
        <Bold>Simulation</Bold>
      </Text>
      <Row label="Estimated resource fee">
        <Text>{`${stroopsToXlm(simulation.minResourceFee)} XLM`}</Text>
      </Row>
      {simulation.authSigners.length > 0 ? (
        <Box>
          <Text>Requires signature from</Text>
          <Copyable value={simulation.authSigners.join('\n')} />
        </Box>
      ) : null}
      {simulation.restoreRequired ? (
        <Banner title="Restore required" severity="warning">
          <Text>
            This call touches archived ledger entries. Submission will fail
            until they are restored (restoreFootprint).
          </Text>
        </Banner>
      ) : null}
    </Section>
  );
}

export type SignTransactionDialogParams = {
  origin: string;
  network: NetworkName;
  tx: Transaction | FeeBumpTransaction;
  xdr: string;
  /** The wallet key that will sign, shown so the user sees who signs. */
  signingAddress: string;
  /**
   * The signing account's SEP-0005 index. Shown next to the address so a
   * dapp selecting a non-active account via the `address` option stays
   * visible ("what you see is what you sign", multi-account extension).
   */
  accountIndex: number;
  /** Present for Soroban transactions: display-verification simulation. */
  simulation?: SimulationSummary | null;
  /** Advisory safety warnings (unfunded destination, SEP-29, multisig). */
  warnings?: string[];
  /** Approval will also broadcast the signed transaction immediately. */
  submit?: boolean;
  /**
   * The endpoint that receives the signed envelope when `submit` is set. Named
   * in the dialog because a submission endpoint is trusted with more than
   * display: it can accept a transaction, report its correct hash, and never
   * broadcast it, retaining a valid signed envelope for later. On PUBLIC the
   * Soroban path is a third-party gateway, so who receives it is not
   * self-evident from the network name alone.
   */
  submitEndpoint?: string;
};

/**
 * The host of a submission endpoint, for inline display. Falls back to the
 * whole string when it cannot be parsed, so a malformed configuration is
 * shown rather than silently dropped from the disclosure.
 *
 * @param endpoint - The endpoint URL.
 * @returns The host, or the original string.
 */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/**
 * Renders advisory safety warnings as banners.
 *
 * @param warnings - The warning strings.
 * @returns Banner elements.
 */
function renderWarnings(warnings: string[]): GenericSnapElement[] {
  return warnings.map((warning) => (
    <Banner title="Check before signing" severity="warning">
      <Text>{warning}</Text>
    </Banner>
  ));
}

/**
 * Builds the full transaction-review dialog. The content is derived only
 * from the parsed XDR — never from dapp-provided summaries.
 *
 * @param params - The dialog parameters.
 * @param params.origin - The requesting dapp origin.
 * @param params.network - The active network name.
 * @param params.tx - The parsed transaction or fee-bump envelope.
 * @param params.xdr - The raw base64 envelope XDR.
 * @param params.signingAddress - The wallet key that will sign.
 * @param params.accountIndex - The signing account's SEP-0005 index.
 * @param params.simulation - Display-verification simulation for Soroban
 * transactions, or null/absent for classic ones.
 * @param params.warnings - Advisory safety warnings for classic transactions.
 * @param params.submit - Approval will also broadcast the transaction.
 * @param params.submitEndpoint - The endpoint that will receive the signed
 * envelope, named in the dialog so the user can see who relays it.
 * @returns The dialog content.
 */
export function buildSignTransactionDialog({
  origin,
  network,
  tx,
  xdr,
  signingAddress,
  accountIndex,
  simulation,
  warnings = [],
  submit = false,
  submitEndpoint,
}: SignTransactionDialogParams): JSXElement {
  const networkBanner =
    network === 'PUBLIC' ? (
      <Banner title="Mainnet" severity="warning">
        <Text>This transaction will move real funds on PUBLIC.</Text>
      </Banner>
    ) : (
      <Banner title={network} severity="info">
        <Text>{`This request is for the ${network} network.`}</Text>
      </Banner>
    );

  const signingWith = (
    <Section>
      <Row label="Signing with">
        <Text>{`Account ${accountIndex}`}</Text>
      </Row>
      <Copyable value={signingAddress} />
    </Section>
  );

  // The user must know before approving that a single approval both signs
  // and irreversibly broadcasts when submit was requested.
  const submitBanner = submit ? (
    <Box>
      <Banner title="Sign and submit" severity="warning">
        <Text>
          Approving signs this transaction and immediately submits it to the
          network. This cannot be undone.
        </Text>
      </Banner>
      {submitEndpoint ? (
        // The endpoint is not merely a data source here: it receives the
        // signed envelope. It can accept it, report the correct hash, and
        // never broadcast, holding a valid signed transaction it may submit
        // later. Naming it lets the user weigh that before approving.
        <Section>
          <Row label="Submitted via">
            <Text>{endpointHost(submitEndpoint)}</Text>
          </Row>
          <Text>
            This service receives the signed transaction and relays it to the
            network. It cannot change what you signed, but it can delay or
            withhold the submission.
          </Text>
        </Section>
      ) : null}
    </Box>
  ) : null;

  const grantNotice = <ConnectionGrantNotice origin={origin} />;

  // Fee-bump envelope: outer fee payer wrapping an already-signed inner tx.
  if (!(tx instanceof Transaction)) {
    const inner = tx.innerTransaction;
    return (
      <Box>
        <Heading>
          {submit ? 'Sign and submit fee bump' : 'Sign fee bump'}
        </Heading>
        <Text>
          <Bold>{displayOrigin(origin)}</Bold> asks you to pay the fee for an
          existing transaction.
        </Text>
        {originCautionBanner(origin)}
        {networkBanner}
        {submitBanner}
        {signingWith}
        {renderWarnings(warnings)}
        <Section>
          <Text>Fee source</Text>
          <Copyable value={tx.feeSource} />
          <Row label="New max fee">
            <Text>{`${stroopsToXlm(tx.fee)} XLM`}</Text>
          </Row>
        </Section>
        <Divider />
        <Text>
          <Bold>Inner transaction</Bold>
        </Text>
        {renderSummary(inner)}
        {inner.operations.map(renderOperation)}
        {renderFootprint(tx)}
        {renderSimulation(simulation ?? null)}
        {grantNotice}
        <Divider />
        <Text>Raw transaction (XDR)</Text>
        <Copyable value={xdr} />
      </Box>
    );
  }

  // A sequence-0 transaction can never execute on-chain — it is typically a
  // SEP-10 login challenge, but the snap does NOT validate the challenge's
  // structure, web-auth domain, time bounds, or server signature.
  // Present it as an unverified signature request, not a confirmed login.
  if (tx.sequence === '0') {
    return (
      <Box>
        <Heading>Signature request</Heading>
        <Text>
          <Bold>{displayOrigin(origin)}</Bold> asks you to sign a sequence-0
          transaction. This is often a login challenge (SEP-10), but the snap
          has not verified the challenge domain or its server signature — only
          approve if you trust the site.
        </Text>
        {originCautionBanner(origin)}
        {networkBanner}
        {signingWith}
        <Banner title="Not a transfer" severity="info">
          <Text>
            A sequence-0 transaction cannot be submitted to the network and does
            not move funds.
          </Text>
        </Banner>
        {renderSummary(tx)}
        {tx.operations.map(renderOperation)}
        {renderFootprint(tx)}
        {grantNotice}
        <Divider />
        <Text>Raw challenge (XDR)</Text>
        <Copyable value={xdr} />
      </Box>
    );
  }

  return (
    <Box>
      <Heading>
        {submit ? 'Sign and submit transaction' : 'Sign transaction'}
      </Heading>
      <Text>
        <Bold>{displayOrigin(origin)}</Bold> asks you to sign
        {submit ? ' and immediately submit' : ''} a Stellar transaction.
      </Text>
      {originCautionBanner(origin)}
      {networkBanner}
      {submitBanner}
      {signingWith}
      {renderWarnings(warnings)}
      {renderSummary(tx)}
      {tx.operations.map(renderOperation)}
      {renderFootprint(tx)}
      {renderSimulation(simulation ?? null)}
      {grantNotice}
      <Divider />
      <Text>Raw transaction (XDR)</Text>
      <Copyable value={xdr} />
    </Box>
  );
}
