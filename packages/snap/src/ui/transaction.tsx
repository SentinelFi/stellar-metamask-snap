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
import {
  AuthClawbackEnabledFlag,
  AuthImmutableFlag,
  AuthRequiredFlag,
  AuthRevocableFlag,
  extractBaseAddress,
  SignerKey,
  Transaction,
} from '@stellar/stellar-sdk/base';
import type {
  FeeBumpTransaction,
  OperationRecord,
  Asset,
  xdr,
} from '@stellar/stellar-sdk/base';
import { Buffer } from 'buffer';

import { ConnectionGrantNotice, originCautionBanner } from './dialogs';
import {
  bytesToDisplay,
  isHexDisplay,
  isLossyInline,
  displayOrigin,
  escapeHiddenCharacters,
  formatAsset,
  formatAssetFull,
  formatLiquidityPool,
  sanitizeInlineText,
  stroopsToXlm,
  truncate,
} from './format';
import type { NetworkName } from '../state/networks';
import type { BalanceChangeSummary } from '../stellar/events';
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
  'manageSellOffer',
  'manageBuyOffer',
  'createPassiveSellOffer',
  'createClaimableBalance',
  'claimClaimableBalance',
  'liquidityPoolDeposit',
  'liquidityPoolWithdraw',
  'invokeHostFunction',
  'extendFootprintTtl',
  'restoreFootprint',
]);

/** Nesting allowed in a claim predicate before rendering refuses it. */
const MAX_CLAIM_PREDICATE_DEPTH = 8;

/**
 * Renders a claimable-balance claim predicate in words, faithfully and in
 * full. Throws on an unknown predicate variant or on nesting beyond
 * {@link MAX_CLAIM_PREDICATE_DEPTH}, so callers fail closed rather than show
 * a condition that is not the one signed; {@link findUndisplayableOperation}
 * runs the same rendering before any dialog is built.
 *
 * @param predicate - The predicate to render.
 * @param depth - Current nesting depth.
 * @returns The rendered condition.
 */
function describeClaimPredicate(
  predicate: xdr.ClaimPredicate,
  depth = 0,
): string {
  if (depth >= MAX_CLAIM_PREDICATE_DEPTH) {
    throw new Error('claim predicate nested too deeply to display');
  }
  // Exhaustive over the known variants; the default arm throws so a variant
  // added by a future SDK fails closed rather than rendering a placeholder.
  switch (predicate.switch().name) {
    case 'claimPredicateUnconditional':
      return 'unconditional';
    case 'claimPredicateAnd':
      return `(${predicate
        .andPredicates()
        .map((inner) => describeClaimPredicate(inner, depth + 1))
        .join(' AND ')})`;
    case 'claimPredicateOr':
      return `(${predicate
        .orPredicates()
        .map((inner) => describeClaimPredicate(inner, depth + 1))
        .join(' OR ')})`;
    case 'claimPredicateNot': {
      const inner = predicate.notPredicate();
      if (!inner) {
        throw new Error('claim predicate NOT without an operand');
      }
      return `NOT ${describeClaimPredicate(inner, depth + 1)}`;
    }
    case 'claimPredicateBeforeAbsoluteTime': {
      const seconds = predicate.absBefore().toString();
      return `before unix time ${formatTimeBound(seconds) ?? seconds}`;
    }
    case 'claimPredicateBeforeRelativeTime':
      return `within ${predicate.relBefore().toString()} seconds of the balance being created`;
    default:
      throw new Error(`unsupported claim predicate ${predicate.switch().name}`);
  }
}

/**
 * Finds an operation whose details the dialog cannot render in full, among
 * the operation types that are otherwise supported. Today that is a
 * claimable balance whose claim predicates use an unknown variant or nest
 * beyond the rendering bound. Mirrors the host-function and footprint
 * checks: the signing path refuses before any dialog is built, so no
 * operation reaches the user with a condition it cannot state.
 *
 * @param tx - The operation-bearing transaction.
 * @returns A reason the transaction cannot be reviewed, or null.
 */
export function findUndisplayableOperation(tx: Transaction): string | null {
  for (const operation of tx.operations) {
    if (operation.type !== 'createClaimableBalance') {
      continue;
    }
    for (const claimant of operation.claimants) {
      try {
        describeClaimPredicate(claimant.predicate);
      } catch {
        return 'a claimable balance whose claim conditions the snap cannot display in full';
      }
    }
  }
  return null;
}

/**
 * Renders an offer or pool price exactly as the protocol stores it: the
 * rational `n/d`, with a decimal reading alongside. The SDK decodes prices to
 * a decimal string that a non-terminating ratio cannot represent, so the raw
 * XDR price is preferred whenever the operation could be re-read; the decoded
 * string is the fallback.
 *
 * @param raw - The raw XDR price, when available.
 * @param decoded - The SDK-decoded decimal price.
 * @returns The display string.
 */
function formatPrice(raw: xdr.Price | null, decoded: string): string {
  if (!raw) {
    return decoded;
  }
  const numerator = BigInt(raw.n());
  const denominator = BigInt(raw.d());
  if (numerator <= 0n || denominator <= 0n) {
    // Not a price the network would accept; shown as stored, not hidden.
    return `${numerator}/${denominator} (invalid price)`;
  }
  const scale = 10_000_000n;
  const scaled = (numerator * scale) / denominator;
  const exact = scaled * denominator === numerator * scale;
  const whole = scaled / scale;
  const fraction = (scaled % scale)
    .toString()
    .padStart(7, '0')
    .replace(/0+$/u, '');
  const decimal = fraction ? `${whole}.${fraction}` : `${whole}`;
  return `${numerator}/${denominator} (${exact ? '=' : 'about'} ${decimal})`;
}

/**
 * Reads the raw price of an offer or pool-deposit operation.
 *
 * @param raw - The raw XDR operation, when available.
 * @param field - Which price to read.
 * @returns The raw price, or null when unavailable.
 */
function rawPrice(
  raw: xdr.Operation | undefined,
  field: 'price' | 'minPrice' | 'maxPrice',
): xdr.Price | null {
  try {
    if (!raw) {
      return null;
    }
    const body = raw.body();
    // Deliberately non-exhaustive: only the operations carrying a price.
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch (body.switch().name) {
      case 'manageSellOffer':
        return body.manageSellOfferOp().price();
      case 'manageBuyOffer':
        return body.manageBuyOfferOp().price();
      case 'createPassiveSellOffer':
        return body.createPassiveSellOfferOp().price();
      case 'liquidityPoolDeposit':
        return field === 'maxPrice'
          ? body.liquidityPoolDepositOp().maxPrice()
          : body.liquidityPoolDepositOp().minPrice();
      default:
        return null;
    }
  } catch {
    return null;
  }
}

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
 * Warns when a field that is nominally text had to be shown as hex because
 * its signed bytes are not clean, printable text.
 *
 * The SDK decodes several string fields with an ASCII decoder that drops the
 * high bit of every byte, so `e3 ef ee e6 e9 e7` decodes to the clean word
 * `config`, and a preview built from that decoded string passes every hidden
 * character check while differing from what is signed. The fields this
 * concerns are therefore rendered from the raw XDR bytes instead, and this
 * banner explains the hex form when that is what the bytes come out as.
 *
 * @param label - What the field is, for the banner title.
 * @param display - The {@link bytesToDisplay} rendering of the field.
 * @returns A warning banner, or null when the field rendered as text.
 */
function rawBytesNotice(
  label: string,
  display: string,
): GenericSnapElement | null {
  if (!isHexDisplay(display)) {
    return null;
  }
  return (
    <Banner title={`${label} is not plain text`} severity="warning">
      <Text>
        The signed bytes of this field are not clean, printable text, so they
        are shown in full as hexadecimal rather than as text that could read
        differently from what you sign.
      </Text>
    </Banner>
  );
}

/**
 * The raw XDR operations of a transaction, in order, for the fields whose
 * SDK-decoded form is lossy (see {@link rawBytesNotice}).
 *
 * @param tx - The parsed transaction.
 * @returns The raw operations, or null when the envelope cannot be re-read.
 */
function rawOperations(tx: Transaction): xdr.Operation[] | null {
  try {
    const envelope = tx.toEnvelope();
    // A `Transaction` is always a v0 or v1 envelope; the remaining envelope
    // types are fee bumps and non-transaction payloads, which never reach
    // this function.
    // eslint-disable-next-line @typescript-eslint/switch-exhaustiveness-check
    switch (envelope.switch().name) {
      case 'envelopeTypeTxV0':
        return envelope.v0().tx().operations();
      case 'envelopeTypeTx':
        return envelope.v1().tx().operations();
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * The raw `dataName` bytes of a `manageData` operation.
 *
 * @param raw - The raw XDR operation, when available.
 * @returns The key bytes, or null when the raw operation is not available
 * or is not a `manageData` operation.
 */
function rawManageDataKey(raw: xdr.Operation | undefined): Buffer | null {
  try {
    return raw ? Buffer.from(raw.body().manageDataOp().dataName()) : null;
  } catch {
    return null;
  }
}

/**
 * The raw `homeDomain` bytes of a `setOptions` operation.
 *
 * @param raw - The raw XDR operation, when available.
 * @returns The home-domain bytes, null when the operation sets none, or
 * undefined when the raw operation is not available.
 */
function rawHomeDomain(
  raw: xdr.Operation | undefined,
): Buffer | null | undefined {
  try {
    if (!raw) {
      return undefined;
    }
    const domain = raw.body().setOptionsOp().homeDomain();
    return domain === null || domain === undefined ? null : Buffer.from(domain);
  } catch {
    return undefined;
  }
}

/**
 * The display form of a `setOptions` home domain: rendered from the raw
 * bytes when the raw operation is available, and from the SDK's decoded
 * string otherwise.
 *
 * @param raw - The raw XDR operation, when available.
 * @param decoded - The SDK-decoded home domain, when the operation sets one.
 * @returns The {@link bytesToDisplay} rendering, or undefined when the
 * operation does not set a home domain.
 */
function homeDomainDisplay(
  raw: xdr.Operation | undefined,
  decoded: string | undefined,
): string | undefined {
  const rawDomain = rawHomeDomain(raw);
  if (rawDomain === undefined) {
    return decoded === undefined
      ? undefined
      : bytesToDisplay(Buffer.from(decoded, 'utf8'));
  }
  return rawDomain === null ? undefined : bytesToDisplay(rawDomain);
}

/**
 * Whether a decoded amount string is zero. The SDK renders amounts as fixed
 * seven-decimal strings (`0.0000000`), so a literal comparison with `'0'`
 * never matches a real envelope.
 *
 * @param amount - The decoded amount.
 * @returns True when the amount is zero.
 */
function isZeroAmount(amount: string): boolean {
  return /^0+(?:\.0+)?$/u.test(amount);
}

/** The protocol's account flags, each a distinct power of two. */
const ACCOUNT_FLAG_NAMES: readonly (readonly [number, string])[] = [
  [AuthRequiredFlag, 'AUTH_REQUIRED'],
  [AuthRevocableFlag, 'AUTH_REVOCABLE'],
  [AuthImmutableFlag, 'AUTH_IMMUTABLE'],
  [AuthClawbackEnabledFlag, 'AUTH_CLAWBACK_ENABLED'],
];

/**
 * Account flags by bit, named as the protocol names them. Unknown bits are
 * shown as numbers so a future flag is never silently dropped.
 *
 * @param flags - The flag bitmask.
 * @returns The decoded display string, e.g. `4 (AUTH_IMMUTABLE)`.
 */
function describeAccountFlags(flags: number): string {
  const names: string[] = [];
  let remaining = flags;
  for (const [bit, name] of ACCOUNT_FLAG_NAMES) {
    if (hasFlag(flags, bit)) {
      names.push(name);
      remaining -= bit;
    }
  }
  if (remaining !== 0) {
    names.push(`unknown flag ${remaining}`);
  }
  return names.length > 0 ? `${flags} (${names.join(', ')})` : String(flags);
}

/**
 * Whether a flag bit is set in a bitmask. Arithmetic rather than bitwise so
 * the lint rule against bitwise operators (which exists to catch a mistyped
 * `&&`) need not be waived: for a power-of-two `bit`, the bit is set exactly
 * when the quotient of `flags` by `bit` is odd.
 *
 * @param flags - The bitmask.
 * @param bit - A single power-of-two flag value.
 * @returns True when the flag is set.
 */
function hasFlag(flags: number, bit: number): boolean {
  return Math.floor(flags / bit) % 2 === 1;
}

/**
 * The classic `G...` account behind an address, unwrapping a muxed `M...`
 * address to the account it routes to. Comparison of "who this is for"
 * against the signing key must happen at the account level: a muxed source
 * is the signer's own account when its base matches.
 *
 * @param address - A `G...` or `M...` address.
 * @returns The base account address, or the input when it is neither.
 */
function baseAccount(address: string): string {
  try {
    return extractBaseAddress(address);
  } catch {
    return address;
  }
}

/**
 * Calls out when the transaction is not for the signing account.
 *
 * The `Source` and `Signing with` fields are both shown in full, but nothing
 * else tells the user that they differ, and two 56-character strings are not
 * something a person diffs by eye. The case that matters is co-signature
 * harvesting: a site asks a user who is a signer on a shared or multisig
 * account to sign an envelope sourced from that account, and the user reads
 * it as their own transaction. The advisory weight check catches some of
 * this for classic transactions when Horizon answers; this banner does not
 * depend on either.
 *
 * @param tx - The parsed transaction.
 * @param signingAddress - The wallet key that will sign.
 * @returns A warning banner, or null when every source is the signer.
 */
function sourceMismatchBanner(
  tx: Transaction,
  signingAddress: string,
): GenericSnapElement | null {
  const signer = baseAccount(signingAddress);
  const lines: string[] = [];
  if (baseAccount(tx.source) !== signer) {
    lines.push(
      `The transaction source is ${truncate(tx.source)}, not the signing account.`,
    );
  }
  const others = tx.operations
    .map((operation, index) => ({ index, source: operation.source }))
    .filter(
      ({ source }) => source !== undefined && baseAccount(source) !== signer,
    )
    .map(({ index }) => index + 1);
  if (others.length > 0) {
    lines.push(
      `Operation${others.length === 1 ? '' : 's'} ${others.join(
        ', ',
      )} ${others.length === 1 ? 'acts' : 'act'} for a source account other than the signing account.`,
    );
  }
  if (lines.length === 0) {
    return null;
  }
  return (
    <Banner title="Not the signing account's transaction" severity="warning">
      <Text>
        {`${lines.join(
          ' ',
        )} Your signature would authorize actions on another account. Compare the full Source and Signing with values before approving.`}
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
 * @param raw - The operation's raw XDR form, when the envelope could be
 * re-read; used for the fields whose decoded form is lossy.
 * @returns The operation section.
 */
function renderOperationBody(
  operation: OperationRecord,
  index: number,
  raw: xdr.Operation | undefined,
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
      // The SDK decodes a zero limit as `0.0000000`, so the comparison must
      // be numeric: a literal `'0'` never matched a real envelope and the
      // removal branch below was unreachable.
      const removing = isZeroAmount(operation.limit);
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
      // Both fields are raw bytes on the wire. The value was always rendered
      // losslessly (clean UTF-8 text or full hex) in a Copyable; the key is
      // now rendered the same way, from the raw XDR rather than from the
      // SDK's decoded string, because that decoder is ASCII and drops the
      // high bit of every byte: a key of non-ASCII bytes decoded to a clean
      // ASCII word that passed every hidden-character check while differing
      // from what is signed. The raw bytes are unavailable only if the
      // envelope could not be re-read, in which case the decoded string is
      // the best available and is rendered through the same path.
      const rawKey = rawManageDataKey(raw);
      const key = bytesToDisplay(rawKey ?? Buffer.from(operation.name, 'utf8'));
      const value =
        operation.value === undefined
          ? undefined
          : bytesToDisplay(Buffer.from(operation.value));
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Manage data`}</Bold>
          </Text>
          {rawBytesNotice('Key', key)}
          {lossyTextBanner([key])}
          <Text>Key</Text>
          <Copyable value={key} />
          {isLossyInline(key) ? (
            // The raw key above keeps line breaks and tabs as they are; this
            // view makes every such code point visible.
            <Box>
              <Text>Key (exact, special characters escaped)</Text>
              <Copyable value={escapeHiddenCharacters(key)} />
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
      const outcomes: GenericSnapElement[] = [];
      if (operation.signer) {
        // Show the signer key itself, not only its weight — adding or
        // removing a signer changes who controls the account. A weight of
        // zero is not a setting: it removes the signer, and the row says so
        // rather than leaving a bare number to be read as harmless.
        const { weight } = operation.signer;
        const removes = weight === 0;
        rows.push(
          <Row label="Signer weight" variant="critical">
            <Text>
              {removes ? '0 (removes this signer)' : String(weight ?? '?')}
            </Text>
          </Row>,
        );
        rows.push(
          <Text>{removes ? 'Signer key being removed' : 'Signer key'}</Text>,
          <Copyable value={describeSigner(operation.signer)} />,
        );
      }
      if (operation.masterWeight !== undefined) {
        const disables = operation.masterWeight === 0;
        rows.push(
          <Row label="Master key weight" variant="critical">
            <Text>
              {disables
                ? '0 (disables the master key)'
                : String(operation.masterWeight)}
            </Text>
          </Row>,
        );
        if (disables) {
          outcomes.push(
            <Banner title="Master key will be disabled" severity="danger">
              <Text>
                With the master key at weight 0 the account's own secret key can
                no longer sign for it. If the remaining signers and thresholds
                do not add up, the account is locked permanently.
              </Text>
            </Banner>,
          );
        }
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
      ] as const) {
        if (value !== undefined) {
          rows.push(
            <Row label={label} variant="warning">
              <Text>{String(value)}</Text>
            </Row>,
          );
        }
      }
      // The home domain is decoded by the SDK with an ASCII decoder that
      // masks the high bit of every byte (see `rawBytesNotice`), so it is
      // rendered from the raw XDR bytes. When the raw envelope cannot be
      // re-read the decoded string is the best available.
      const homeDomain = homeDomainDisplay(raw, operation.homeDomain);
      if (homeDomain !== undefined) {
        if (isHexDisplay(homeDomain)) {
          rows.push(<Text>Home domain</Text>, <Copyable value={homeDomain} />);
        } else {
          rows.push(
            <Row label="Home domain" variant="warning">
              <Text>{sanitizeInlineText(homeDomain)}</Text>
            </Row>,
          );
        }
      }
      // Flags are shown by name, not only by bit: `4` says nothing, while
      // `AUTH_IMMUTABLE` is the one setting on an account that can never be
      // undone, and setting it deserves its own warning.
      if (operation.setFlags !== undefined) {
        rows.push(
          <Row label="Set flags" variant="warning">
            <Text>{describeAccountFlags(operation.setFlags)}</Text>
          </Row>,
        );
        if (hasFlag(operation.setFlags, AuthImmutableFlag)) {
          outcomes.push(
            <Banner title="Irreversible: AUTH_IMMUTABLE" severity="danger">
              <Text>
                Setting AUTH_IMMUTABLE permanently freezes the account's
                authorization flags and prevents the account from ever being
                merged. This cannot be undone by any later transaction.
              </Text>
            </Banner>,
          );
        }
      }
      if (operation.clearFlags !== undefined) {
        rows.push(
          <Row label="Clear flags" variant="warning">
            <Text>{describeAccountFlags(operation.clearFlags)}</Text>
          </Row>,
        );
      }
      return (
        <Section>
          <Banner title={`${title}: Set options`} severity="warning">
            <Text>
              This operation changes account settings and can affect who
              controls the account. Review carefully.
            </Text>
          </Banner>
          {outcomes}
          {homeDomain === undefined
            ? null
            : rawBytesNotice('Home domain', homeDomain)}
          {lossyTextBanner([homeDomain])}
          {rows}
          {homeDomain !== undefined && isLossyInline(homeDomain) ? (
            // The row above is a sanitized preview; show the exact signed
            // value with hidden characters escaped visibly.
            <Box>
              <Text>Home domain (exact, special characters escaped)</Text>
              <Copyable value={escapeHiddenCharacters(homeDomain)} />
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

    case 'manageSellOffer':
    case 'createPassiveSellOffer': {
      // A sell offer: `amount` of `selling` offered at `price` units of
      // `buying` per unit sold. Offer ID 0 creates; a non-zero ID updates
      // that offer, and amount 0 deletes it. Passive offers have no ID.
      const passive = operation.type === 'createPassiveSellOffer';
      const offerId = passive ? '0' : operation.offerId;
      const deleting = !passive && isZeroAmount(operation.amount);
      let heading = 'Create sell offer';
      if (passive) {
        heading = 'Create passive sell offer';
      } else if (deleting) {
        heading = `Delete sell offer #${offerId}`;
      } else if (offerId !== '0') {
        heading = `Update sell offer #${offerId}`;
      }
      return (
        <Section>
          <Text>
            <Bold>{`${title}: ${heading}`}</Bold>
          </Text>
          {deleting ? (
            <Row label="Amount" variant="warning">
              <Text>{`0 (removes offer #${offerId})`}</Text>
            </Row>
          ) : (
            <Row label="Selling">
              <Text>{`${operation.amount} ${formatAsset(operation.selling)}`}</Text>
            </Row>
          )}
          <Row label="Buying">
            <Text>{formatAsset(operation.buying)}</Text>
          </Row>
          <Row
            label={`Price (${formatAsset(operation.buying)} per 1 ${formatAsset(
              operation.selling,
            )})`}
          >
            <Text>{formatPrice(rawPrice(raw, 'price'), operation.price)}</Text>
          </Row>
          {renderAssetFull('Selling asset', operation.selling)}
          {renderAssetFull('Buying asset', operation.buying)}
          {passive ? (
            <Text>
              A passive offer does not take existing offers at the same price;
              it only fills against better ones.
            </Text>
          ) : null}
        </Section>
      );
    }

    case 'manageBuyOffer': {
      // A buy offer: acquire `buyAmount` of `buying`, paying `price` units of
      // `selling` per unit bought.
      const deleting = isZeroAmount(operation.buyAmount);
      let heading = 'Create buy offer';
      if (deleting) {
        heading = `Delete buy offer #${operation.offerId}`;
      } else if (operation.offerId !== '0') {
        heading = `Update buy offer #${operation.offerId}`;
      }
      return (
        <Section>
          <Text>
            <Bold>{`${title}: ${heading}`}</Bold>
          </Text>
          {deleting ? (
            <Row label="Amount" variant="warning">
              <Text>{`0 (removes offer #${operation.offerId})`}</Text>
            </Row>
          ) : (
            <Row label="Buying">
              <Text>{`${operation.buyAmount} ${formatAsset(operation.buying)}`}</Text>
            </Row>
          )}
          <Row label="Paying with">
            <Text>{formatAsset(operation.selling)}</Text>
          </Row>
          <Row
            label={`Price (${formatAsset(operation.selling)} per 1 ${formatAsset(
              operation.buying,
            )})`}
          >
            <Text>{formatPrice(rawPrice(raw, 'price'), operation.price)}</Text>
          </Row>
          {renderAssetFull('Buying asset', operation.buying)}
          {renderAssetFull('Paying asset', operation.selling)}
        </Section>
      );
    }

    case 'createClaimableBalance': {
      // The amount leaves the source account now and is held on the ledger
      // until one of the claimants claims it under their condition. The
      // claimants and their conditions are the whole content of the
      // operation, so they are listed in full; an undecodable condition is
      // refused before the dialog exists (see findUndisplayableOperation).
      const claimants = operation.claimants.map((claimant, position) => {
        let condition: string;
        try {
          condition = describeClaimPredicate(claimant.predicate);
        } catch {
          condition = '(condition cannot be displayed)';
        }
        return `#${position + 1} ${claimant.destination}\ncan claim: ${condition}`;
      });
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Create claimable balance`}</Bold>
          </Text>
          <Row label="Amount" variant="warning">
            <Text>{`${operation.amount} ${formatAsset(operation.asset)}`}</Text>
          </Row>
          {renderAssetFull('Asset', operation.asset)}
          <Text>
            {`This amount leaves the source account now and is held until one of the ${operation.claimants.length} claimant${
              operation.claimants.length === 1 ? '' : 's'
            } below claims it. Each condition is checked when they claim.`}
          </Text>
          <Text>{`Claimants (${operation.claimants.length})`}</Text>
          <Copyable value={claimants.join('\n\n')} />
        </Section>
      );
    }

    case 'claimClaimableBalance':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Claim claimable balance`}</Bold>
          </Text>
          <Text>
            Claims the balance below into the source account, if the source
            account is one of its claimants and its condition holds. The asset
            and amount are not part of this operation; they are those of the
            balance being claimed.
          </Text>
          <Text>Balance ID</Text>
          <Copyable value={operation.balanceId} />
        </Section>
      );

    case 'liquidityPoolDeposit':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Deposit into liquidity pool`}</Bold>
          </Text>
          <Text>
            Deposits up to the two maximum amounts below into the pool in
            exchange for pool shares, within the price range given. The pool and
            its two assets are identified only by the pool ID; compare it with
            the pool you intend.
          </Text>
          <Text>Pool ID</Text>
          <Copyable value={operation.liquidityPoolId} />
          <Row label="Max amount A">
            <Text>{operation.maxAmountA}</Text>
          </Row>
          <Row label="Max amount B">
            <Text>{operation.maxAmountB}</Text>
          </Row>
          <Row label="Min price (A per B)">
            <Text>
              {formatPrice(rawPrice(raw, 'minPrice'), operation.minPrice)}
            </Text>
          </Row>
          <Row label="Max price (A per B)">
            <Text>
              {formatPrice(rawPrice(raw, 'maxPrice'), operation.maxPrice)}
            </Text>
          </Row>
        </Section>
      );

    case 'liquidityPoolWithdraw':
      return (
        <Section>
          <Text>
            <Bold>{`${title}: Withdraw from liquidity pool`}</Bold>
          </Text>
          <Text>
            Redeems the pool shares below for the pool's two assets, receiving
            at least the two minimum amounts. The pool and its assets are
            identified only by the pool ID; compare it with the pool you intend.
          </Text>
          <Text>Pool ID</Text>
          <Copyable value={operation.liquidityPoolId} />
          <Row label="Pool shares">
            <Text>{operation.amount}</Text>
          </Row>
          <Row label="Min amount A">
            <Text>{operation.minAmountA}</Text>
          </Row>
          <Row label="Min amount B">
            <Text>{operation.minAmountB}</Text>
          </Row>
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
            // The legend says which entries this signature itself
            // authorizes. An entry marked [source-account] is approved by
            // the transaction signature; an entry naming an address is
            // approved by that address's own signature on the entry, which
            // is collected separately (or is already attached) and is not
            // what approving this dialog produces.
            <Text>
              Entries marked [source-account] are authorized by this transaction
              signature. Entries naming an address need that address to sign the
              entry itself.
            </Text>
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
 * @param raw - The operation's raw XDR form, when available.
 * @returns The operation section.
 */
function renderOperation(
  operation: OperationRecord,
  index: number,
  raw: xdr.Operation | undefined,
): GenericSnapElement {
  const body = renderOperationBody(operation, index, raw);
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
 * Renders every operation of a transaction, pairing each decoded operation
 * with its raw XDR counterpart so the fields whose decoded form is lossy can
 * be rendered from the signed bytes.
 *
 * @param tx - The parsed transaction.
 * @returns One section per operation.
 */
function renderOperations(tx: Transaction): GenericSnapElement[] {
  const raws = rawOperations(tx);
  return tx.operations.map((operation, index) =>
    renderOperation(operation, index, raws?.[index]),
  );
}

/**
 * The memo rows: an inline preview, and, whenever that preview is not the
 * exact signed value, an exact copy alongside.
 *
 * A text memo is bytes on the wire, and the SDK's decoded string maps any
 * invalid UTF-8 sequence to U+FFFD, so two different byte strings could
 * render identically with nothing to signal it. The rows are therefore built
 * from the raw memo bytes: clean UTF-8 renders as text, anything else as the
 * full hex form with the lossy banner, the same treatment `manageData` values
 * get.
 *
 * @param tx - The parsed transaction.
 * @returns The memo elements, empty when the memo is `none`.
 */
function renderMemo(tx: Transaction): GenericSnapElement[] {
  const { memo } = tx;
  switch (memo.type) {
    case 'text': {
      const bytes = Buffer.isBuffer(memo.value)
        ? memo.value
        : Buffer.from(String(memo.value ?? ''), 'utf8');
      const display = bytesToDisplay(bytes);
      const rows: GenericSnapElement[] = [];
      if (isHexDisplay(display)) {
        rows.push(
          <Banner title="Display differs from signed text" severity="warning">
            <Text>
              The memo bytes are not clean, printable text, so they cannot be
              shown as text without loss. The exact bytes are shown below as
              hexadecimal.
            </Text>
          </Banner>,
          <Row label="Memo (text)">
            <Text>{sanitizeInlineText(bytes.toString('utf8'))}</Text>
          </Row>,
          <Text>Memo (exact bytes)</Text>,
          <Copyable value={display} />,
        );
        return rows;
      }
      const banner = lossyTextBanner([display]);
      if (banner) {
        rows.push(banner);
      }
      rows.push(
        <Row label="Memo (text)">
          <Text>{sanitizeInlineText(display)}</Text>
        </Row>,
      );
      if (isLossyInline(display)) {
        // The inline row above is a sanitized preview; give the user the
        // exact signed text with hidden characters escaped visibly.
        rows.push(
          <Text>Memo (exact, special characters escaped)</Text>,
          <Copyable value={escapeHiddenCharacters(display)} />,
        );
      }
      return rows;
    }
    case 'id':
      return [
        <Row label="Memo (ID)">
          <Text>{String(memo.value)}</Text>
        </Row>,
      ];
    case 'hash':
      return [
        <Row label="Memo (hash)">
          <Text>{Buffer.from(memo.value as Buffer).toString('hex')}</Text>
        </Row>,
      ];
    case 'return':
      return [
        <Row label="Memo (return)">
          <Text>{Buffer.from(memo.value as Buffer).toString('hex')}</Text>
        </Row>,
      ];
    case 'none':
    default:
      return [];
  }
}

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
 * Header rows shared by regular transactions: full source (with a warning
 * when it is not the signing account), fee, sequence, memo (rendered from
 * its signed bytes, with a warning when the preview is not exact), and
 * preconditions.
 *
 * @param tx - The parsed transaction.
 * @param signingAddress - The wallet key that will sign.
 * @returns The summary section.
 */
function renderSummary(
  tx: Transaction,
  signingAddress: string,
): GenericSnapElement {
  // A sequence-0 envelope can never execute, so its (absent) expiry is moot:
  // the banner would be noise on a login challenge, whose own branch already
  // explains that it cannot be submitted at all. The same goes for the
  // source-account banner: a SEP-10 challenge is sourced from the server's
  // account by design, and that branch states that nothing is executed.
  const executable = tx.sequence !== '0';
  const unbounded = executable && !hasUpperTimeBound(tx);
  return (
    <Section>
      {executable ? sourceMismatchBanner(tx, signingAddress) : null}
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
      {renderMemo(tx)}
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
 * Renders the net token movements the simulation reported for the signing
 * account.
 *
 * This is the part of a contract call a user can actually judge. The decoded
 * invocation above shows a function name and its arguments, which are the
 * inputs the call is authorized with, not its effects: `swap(a, b, 100, 95)`
 * does not say whose balance moves or by how much, and a hostile contract may
 * name its drain function anything at all.
 *
 * Two absences are deliberately made explicit. An empty list renders a line
 * saying so rather than nothing, because a missing section reads as "not
 * applicable" (the same defect as a fee estimate rendered as zero). And a
 * summary that lost an event renders a banner, because a list the user
 * believes is complete is worse than no list at all.
 *
 * @param summary - The balance-change summary, when one was computed.
 * @returns The balance-change block, or null when there is nothing to key it
 * against.
 */
function renderBalanceChanges(
  summary: BalanceChangeSummary | undefined,
): GenericSnapElement | null {
  if (!summary) {
    return null;
  }
  return (
    <Box>
      <Text>Balance changes for the signing account</Text>
      {summary.partial ? (
        <Banner title="Movements may be missing" severity="warning">
          <Text>
            Part of the simulation could not be read, so this list may be
            incomplete. Treat it as a hint, not a full accounting.
          </Text>
        </Banner>
      ) : null}
      {summary.changes.length === 0 ? (
        <Text>
          The simulation reported no token movements for this account. A
          contract can move balances without reporting them, so this is not a
          guarantee.
        </Text>
      ) : (
        <Box>
          {summary.changes.map((change) => (
            <Row
              // The label is either a snap-derived asset name or a truncated
              // contract address; both are safe, but the amount is formatted
              // from contract-reported numbers and is sanitized on principle.
              label={sanitizeInlineText(change.asset)}
              variant={change.amount.startsWith('-') ? 'warning' : 'default'}
            >
              <Text>
                {change.rawUnits
                  ? `${change.amount} (smallest unit)`
                  : change.amount}
              </Text>
            </Row>
          ))}
          {/* The row labels shorten addresses, and a shortened address is
              exactly what a lookalike token is ground to match. The full
              identities are offered alongside so the user can compare the
              whole contract address or issuer, not its ends. */}
          <Text>Assets in full</Text>
          <Copyable
            value={summary.changes
              .map(
                (change) =>
                  `${sanitizeInlineText(change.asset)}: ${change.identity}`,
              )
              .join('\n')}
          />
        </Box>
      )}
    </Box>
  );
}

/**
 * Renders the display-verification simulation results for a Soroban
 * transaction.
 *
 * Every figure in this section is reported by an RPC endpoint the snap
 * cannot independently verify (on PUBLIC, a third-party gateway), and the
 * section says so in words. The empty and partial balance-change cases
 * already carried a caveat; a populated list, a fee, and a signer list
 * carried none, and numbers under a "Simulation" heading read as the snap's
 * own findings unless told otherwise.
 *
 * @param simulation - The simulation summary, or null when not simulated.
 * @param rpcEndpoint - The endpoint that produced the simulation, named in
 * the section so the user knows whose figures these are.
 * @returns The simulation section, or null.
 */
function renderSimulation(
  simulation: SimulationSummary | null,
  rpcEndpoint: string | undefined,
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
      <Text>
        {`Reported by ${
          rpcEndpoint ? endpointHost(rpcEndpoint) : 'the network RPC endpoint'
        }. The wallet cannot independently verify these figures; a wrong or hostile endpoint could misreport them.`}
      </Text>
      {renderBalanceChanges(simulation.balanceChanges)}
      {simulation.minResourceFee === null ? (
        // An absent estimate is not a zero estimate: rendering it as `0 XLM`
        // would claim the call is free, which nothing supports.
        <Row label="Estimated resource fee" variant="warning">
          <Text>unavailable (not reported by the endpoint)</Text>
        </Row>
      ) : (
        <Row label="Estimated resource fee">
          <Text>{`${stroopsToXlm(simulation.minResourceFee)} XLM`}</Text>
        </Row>
      )}
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
  /**
   * The RPC endpoint that produced the simulation, named in the simulation
   * section so the user knows whose figures they are reading.
   */
  simulationEndpoint?: string;
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
 * @param params.simulationEndpoint - The RPC endpoint that produced it.
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
  simulationEndpoint,
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
    // The fee source is the account this signature authorizes. When it is
    // not the signing account, the user is co-signing someone else's fee
    // payment, which deserves the same call-out a foreign source gets on an
    // ordinary transaction.
    const foreignFeeSource =
      baseAccount(tx.feeSource) !== baseAccount(signingAddress);
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
        {foreignFeeSource ? (
          <Banner
            title="Fee source is not the signing account"
            severity="warning"
          >
            <Text>
              {`The fee for this bump is paid by ${truncate(
                tx.feeSource,
              )}, not by the signing account. Your signature would authorize that account to pay. Compare the full Fee source and Signing with values before approving.`}
            </Text>
          </Banner>
        ) : null}
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
        {renderSummary(inner, signingAddress)}
        {renderOperations(inner)}
        {renderFootprint(tx)}
        {renderSimulation(simulation ?? null, simulationEndpoint)}
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
        {renderSummary(tx, signingAddress)}
        {renderOperations(tx)}
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
      {renderSummary(tx, signingAddress)}
      {renderOperations(tx)}
      {renderFootprint(tx)}
      {renderSimulation(simulation ?? null, simulationEndpoint)}
      {grantNotice}
      <Divider />
      <Text>Raw transaction (XDR)</Text>
      <Copyable value={xdr} />
    </Box>
  );
}
