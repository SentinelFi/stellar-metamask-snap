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
import type { FeeBumpTransaction, OperationRecord } from '@stellar/stellar-sdk';
import { Transaction } from '@stellar/stellar-sdk';
import { Buffer } from 'buffer';

import {
  formatAsset,
  formatMemo,
  sanitizeInlineText,
  stroopsToXlm,
  truncate,
} from './format';
import type { NetworkName } from '../state/networks';
import type { SimulationSummary } from '../stellar/soroban';
import { decodeHostFunction, summarizeAuthEntries } from '../stellar/soroban';

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
    <Row label="Operation source">
      <Text>{truncate(operation.source)}</Text>
    </Row>
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
          <Text>Destination</Text>
          <Copyable value={operation.destination} />
        </Section>
      );

    case 'manageData':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Manage data`}</Bold>
          </Text>
          <Row label="Key">
            <Text>{sanitizeInlineText(operation.name)}</Text>
          </Row>
          <Row label="Value">
            <Text>
              {operation.value === undefined
                ? 'Delete entry'
                : truncate(
                    sanitizeInlineText(
                      Buffer.from(operation.value).toString('utf8'),
                    ),
                    24,
                  )}
            </Text>
          </Row>
        </Section>
      );

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
          {rows}
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
                the raw transaction XDR below.
              </Text>
            </Banner>
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
          <Row label="Function">
            <Text>{sanitizeInlineText(decoded.functionName ?? '')}</Text>
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
function renderSummary(tx: Transaction): GenericSnapElement {
  const memo = formatMemo(tx.memo);
  return (
    <Section>
      <Row label="Source">
        <Text>{truncate(tx.source)}</Text>
      </Row>
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
          <Text>{simulation.error}</Text>
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
      {simulation.authSigners.map((signer) => (
        <Row label="Requires signature from">
          <Text>{truncate(signer, 8)}</Text>
        </Row>
      ))}
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
  /** Present for Soroban transactions: display-verification simulation. */
  simulation?: SimulationSummary | null;
  /** Advisory safety warnings (unfunded destination, SEP-29, multisig). */
  warnings?: string[];
};

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
 * @param params.simulation - Display-verification simulation for Soroban
 * transactions, or null/absent for classic ones.
 * @param params.warnings - Advisory safety warnings for classic transactions.
 * @returns The dialog content.
 */
export function buildSignTransactionDialog({
  origin,
  network,
  tx,
  xdr,
  signingAddress,
  simulation,
  warnings = [],
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
      <Text>Signing with</Text>
      <Copyable value={signingAddress} />
    </Section>
  );

  // Fee-bump envelope: outer fee payer wrapping an already-signed inner tx.
  if (!(tx instanceof Transaction)) {
    const inner = tx.innerTransaction;
    return (
      <Box>
        <Heading>Sign fee bump</Heading>
        <Text>
          <Bold>{origin}</Bold> asks you to pay the fee for an existing
          transaction.
        </Text>
        {networkBanner}
        {signingWith}
        {renderWarnings(warnings)}
        <Section>
          <Row label="Fee source">
            <Text>{truncate(tx.feeSource)}</Text>
          </Row>
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
          <Bold>{origin}</Bold> asks you to sign a sequence-0 transaction. This
          is often a login challenge (SEP-10), but the snap has not verified the
          challenge domain or its server signature — only approve if you trust
          the site.
        </Text>
        {signingWith}
        <Banner title="Not a transfer" severity="info">
          <Text>
            A sequence-0 transaction cannot be submitted to the network and does
            not move funds.
          </Text>
        </Banner>
        {tx.operations.map(renderOperation)}
        <Divider />
        <Text>Raw challenge (XDR)</Text>
        <Copyable value={xdr} />
      </Box>
    );
  }

  return (
    <Box>
      <Heading>Sign transaction</Heading>
      <Text>
        <Bold>{origin}</Bold> asks you to sign a Stellar transaction.
      </Text>
      {networkBanner}
      {signingWith}
      {renderWarnings(warnings)}
      {renderSummary(tx)}
      {tx.operations.map(renderOperation)}
      {renderSimulation(simulation ?? null)}
      <Divider />
      <Text>Raw transaction (XDR)</Text>
      <Copyable value={xdr} />
    </Box>
  );
}
