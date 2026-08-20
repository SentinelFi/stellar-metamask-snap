import { Address, Asset, scValToNative, xdr } from '@stellar/stellar-sdk/base';
import { Buffer } from 'buffer';

import { formatTokenAmount } from './token';
import type { TrackedToken } from '../state';
import {
  formatAsset,
  formatAssetFull,
  formatTokenAsset,
  formatUnknownTokenAsset,
} from '../ui/format';

/**
 * Decodes the token-movement events a Soroban simulation reports into a net
 * per-asset balance change for one account.
 *
 * Why this exists: a contract call renders as a function name and a list of
 * ScVal arguments. Those are the *inputs* the user authorizes, not the
 * effects. `swap(a, b, 100, 95)` says nothing about which balances move or by
 * how much, and a hostile contract is free to name its drain function
 * anything at all. The simulation's events are the only place the effects
 * become legible before signing.
 *
 * Everything here is untrusted input twice over: the events come from an
 * endpoint-controlled RPC response, and their contents are chosen by a
 * contract the dapp picked. Nothing decoded here may be displayed on the
 * contract's word alone — see {@link resolveAsset} for the one place a
 * contract-supplied asset name is accepted, and what it must prove first.
 */

/** SEP-41 / Stellar Asset Contract event kinds that move a balance. */
const BALANCE_EVENT_KINDS = new Set(['transfer', 'mint', 'burn', 'clawback']);

/**
 * Events decoded per simulation. The array is endpoint-controlled, so it is
 * bounded like every other simulation array; a response carrying more is
 * reported as partial rather than silently trimmed.
 */
const MAX_EVENTS = 100;

/** Distinct assets shown. Beyond this the summary is marked partial. */
const MAX_BALANCE_ASSETS = 12;

/**
 * Stellar Asset Contracts always use 7 decimals, like the classic asset.
 * Exported because this is a protocol constant, not a convention: `addToken`
 * uses it to refuse a verified SAC whose endpoint-reported decimals disagree,
 * since only a lying endpoint can produce that answer.
 */
export const SAC_DECIMALS = 7;

/** A net balance change for one asset. */
export type BalanceChange = {
  /** Display label: `XLM`, `USDC (GA23…4XYZ)`, or `Token CDLZ…CYSC`. */
  asset: string;
  /**
   * The complete, lossless identity behind the label: `XLM (native)`, the
   * full `CODE:ISSUER` of a verified Stellar Asset Contract, or the full
   * contract address. The label shortens addresses for the row, and a
   * shortened address is what a lookalike contract is ground to match, so
   * the dialog offers this alongside for the user to compare in full.
   */
  identity: string;
  /** Signed net change, formatted at the asset's precision. */
  amount: string;
  /**
   * The token's precision could not be established, so `amount` is in the
   * token's smallest unit. The dialog must say so: `1000000` of an unknown
   * token is not `1000000` tokens.
   */
  rawUnits: boolean;
};

export type BalanceChangeSummary = {
  /** Net changes for the account, outgoing first. Empty is meaningful. */
  changes: BalanceChange[];
  /**
   * At least one event could not be decoded, or a cap was hit. The list may
   * therefore be missing a movement, and the dialog says so: an incomplete
   * list that reads as complete is worse than no list.
   */
  partial: boolean;
};

/** The empty summary, for the paths that decode nothing. */
const EMPTY: BalanceChangeSummary = { changes: [], partial: false };

/**
 * Resolves an event topic to an address string. Muxed addresses resolve to
 * their underlying `G...` account: the multiplexing id selects a sub-account
 * inside the recipient's own bookkeeping, and the balance still moves on the
 * base account, which is what the user is matching against.
 *
 * @param value - The topic ScVal.
 * @returns The address, or null when the topic is not an address.
 */
function topicAddress(value: xdr.ScVal): string | null {
  if (value.switch().name !== 'scvAddress') {
    return null;
  }
  try {
    const address = value.address();
    if (address.switch().name === 'scAddressTypeMuxedAccount') {
      return Address.account(address.muxedAccount().ed25519()).toString();
    }
    return Address.fromScAddress(address).toString();
  } catch {
    return null;
  }
}

/**
 * Reads the amount an event carries. Post-CAP-67 transfers may carry a map
 * (`amount` plus a muxed recipient id) where earlier ones carried a bare
 * i128, so both shapes are accepted.
 *
 * @param data - The event's data ScVal.
 * @returns The amount, or null when no integer amount is present.
 */
function readAmount(data: xdr.ScVal): bigint | null {
  let native: unknown;
  try {
    native = scValToNative(data);
  } catch {
    return null;
  }
  const candidate =
    native !== null && typeof native === 'object' && !Array.isArray(native)
      ? (native as Record<string, unknown>).amount
      : native;
  if (typeof candidate === 'bigint') {
    return candidate;
  }
  if (typeof candidate === 'number' && Number.isInteger(candidate)) {
    return BigInt(candidate);
  }
  return null;
}

/** The two accounts an event debits and credits. */
type Movement = { from: string | null; to: string | null; amount: bigint };

/**
 * Extracts the debited and credited accounts from a token event's topics.
 *
 * Topic layouts differ across the SAC's history (`mint` dropped its admin
 * topic in CAP-67, `clawback` did not), so positions are read relative to the
 * end rather than by fixed index: the payer/payee is the last address topic
 * in every single-sided layout, and the first two in a transfer.
 *
 * @param kind - The event kind (topic 0).
 * @param addresses - The address topics, in order.
 * @param amount - The event amount.
 * @returns The movement, or null when the topics do not name the parties.
 */
function toMovement(
  kind: string,
  addresses: string[],
  amount: bigint,
): Movement | null {
  const last = addresses[addresses.length - 1] ?? null;
  switch (kind) {
    case 'transfer':
      return addresses.length >= 2 && addresses[0] && addresses[1]
        ? { from: addresses[0], to: addresses[1], amount }
        : null;
    case 'mint':
      return last ? { from: null, to: last, amount } : null;
    case 'burn':
    case 'clawback':
      return last ? { from: last, to: null, amount } : null;
    default:
      return null;
  }
}

/** How an asset is labelled and scaled in the summary. */
type AssetIdentity = {
  label: string;
  identity: string;
  decimals: number | null;
};

/**
 * Resolves the asset label and precision for an event.
 *
 * The trailing string topic is the SAC's `CODE:ISSUER` (or `native`) asset
 * name, and it is the one field here a contract could use to impersonate a
 * real asset: any contract may emit a `transfer` event claiming to be
 * `native`, which would render a fabricated XLM row. It is therefore only
 * trusted when the emitting contract *is* that asset's Stellar Asset
 * Contract, which is a deterministic address the snap recomputes and
 * compares. A mismatch falls through to the contract-address label, so the
 * row still appears and still says which contract moved.
 *
 * Tokens the user added themselves are the second source of truth: their
 * symbol and decimals were validated when they were added, and they are keyed
 * by the emitting contract, which the host sets and no contract can forge.
 *
 * @param assetTopic - The trailing string topic, when present.
 * @param contractId - The emitting contract address.
 * @param networkPassphrase - Passphrase of the active network, which the SAC
 * address derivation is bound to.
 * @param tokens - Tokens tracked for the active network.
 * @param sacCache - Memo for the derived SAC addresses (one hash per asset).
 * @returns The label and precision to display.
 */
function resolveAsset(
  assetTopic: string | null,
  contractId: string,
  networkPassphrase: string,
  tokens: TrackedToken[],
  sacCache: Map<string, SacIdentity | null>,
): AssetIdentity {
  if (assetTopic !== null) {
    let candidate = sacCache.get(assetTopic);
    if (candidate === undefined) {
      candidate = deriveSacIdentity(assetTopic, networkPassphrase);
      sacCache.set(assetTopic, candidate);
    }
    // The comparison happens per event, never per cache entry: what is
    // memoized is the derivation, not the verdict. Caching the verdict would
    // let the first contract to legitimately claim an asset name lend that
    // name to every later contract claiming the same one, which is precisely
    // the impersonation this check exists to stop.
    if (candidate && candidate.contract === contractId) {
      return {
        label: candidate.label,
        identity: candidate.identity,
        decimals: candidate.decimals,
      };
    }
  }

  const tracked = tokens.find((token) => token.contractId === contractId);
  if (tracked) {
    return {
      label: formatTokenAsset(tracked.symbol, tracked.contractId),
      identity: tracked.contractId,
      decimals: tracked.decimals,
    };
  }

  return {
    label: formatUnknownTokenAsset(contractId),
    identity: contractId,
    decimals: null,
  };
}

/**
 * A claimed asset name resolved to the contract address that alone is
 * entitled to use it on this network.
 */
type SacIdentity = AssetIdentity & { contract: string };

/**
 * The classic asset identity a contract is entitled to, when it is that
 * asset's Stellar Asset Contract.
 *
 * A token contract's self-reported `name()` is as forgeable as its symbol,
 * so the name alone proves nothing. What it does give is a claim that can be
 * checked: if the name parses as `CODE:ISSUER` (or `native`) and the Stellar
 * Asset Contract address the snap derives for that asset on this network is
 * the contract in question, then the contract is that asset by construction,
 * and the dialog can say so. Any other contract gets null, and its symbol
 * stays marked as unverified.
 *
 * @param name - The contract-reported name, or null when it could not be read.
 * @param contractId - The contract being added.
 * @param networkPassphrase - The active network passphrase, which the SAC
 * derivation is bound to.
 * @returns `XLM (native)` or the full `CODE:ISSUER`, or null when the
 * contract is not the Stellar Asset Contract of the asset it names.
 */
export function verifiedStellarAssetIdentity(
  name: string | null,
  contractId: string,
  networkPassphrase: string,
): string | null {
  if (name === null) {
    return null;
  }
  const candidate = deriveSacIdentity(name, networkPassphrase);
  if (candidate && candidate.contract === contractId) {
    return candidate.identity;
  }
  return null;
}

/**
 * Derives what a claimed SAC asset name would look like, and which contract
 * would have to emit it for the claim to hold. The caller compares.
 *
 * @param assetTopic - The claimed asset name (`native` or `CODE:ISSUER`).
 * @param networkPassphrase - The active network passphrase.
 * @returns The identity, or null when the name is not a well-formed asset.
 */
function deriveSacIdentity(
  assetTopic: string,
  networkPassphrase: string,
): SacIdentity | null {
  try {
    let asset: Asset;
    if (assetTopic === 'native') {
      asset = Asset.native();
    } else {
      const separator = assetTopic.indexOf(':');
      const code = assetTopic.slice(0, separator);
      const issuer = assetTopic.slice(separator + 1);
      if (separator < 1 || !issuer) {
        return null;
      }
      // The Asset constructor validates both halves and throws otherwise.
      asset = new Asset(code, issuer);
    }
    return {
      label: formatAsset(asset),
      identity: formatAssetFull(asset) ?? 'XLM (native)',
      decimals: SAC_DECIMALS,
      contract: asset.contractId(networkPassphrase),
    };
  } catch {
    return null;
  }
}

/** Accumulator for one asset's net movement. */
type Tally = {
  label: string;
  identity: string;
  decimals: number | null;
  delta: bigint;
};

/** A decoded contract event, reduced to the fields this module reads. */
type DecodedEvent = {
  contractId: string;
  topics: xdr.ScVal[];
  data: xdr.ScVal;
};

/**
 * Decodes one base64 `DiagnosticEvent` into its contract event fields.
 *
 * The three outcomes are distinct on purpose. `'skip'` means the event
 * carries no balance semantics (a failed sub-call, a host diagnostic) and its
 * absence from the summary is correct. `null` means decoding failed, which
 * the caller must escalate to a partial summary: an event it cannot read may
 * be the one that moves the money.
 *
 * @param raw - Base64 `DiagnosticEvent` XDR.
 * @returns The decoded event, `'skip'`, or null when undecodable.
 */
function decodeEvent(raw: string): DecodedEvent | 'skip' | null {
  try {
    const diagnostic = xdr.DiagnosticEvent.fromXDR(raw, 'base64');
    // A failed sub-call's events describe effects that did not happen.
    if (!diagnostic.inSuccessfulContractCall()) {
      return 'skip';
    }
    const event = diagnostic.event();
    // Diagnostic and system events are host bookkeeping, not token
    // movements; only contract events carry SEP-41 semantics.
    if (event.type().name !== 'contract') {
      return 'skip';
    }
    const rawContractId = event.contractId();
    if (!rawContractId) {
      return 'skip';
    }
    if (event.body().switch() !== 0) {
      // A future event body this decoder does not know how to read.
      return null;
    }
    const body = event.body().v0();
    return {
      contractId: Address.contract(
        Buffer.from(rawContractId as unknown as Uint8Array),
      ).toString(),
      topics: body.topics(),
      data: body.data(),
    };
  } catch {
    return null;
  }
}

/**
 * Summarizes a simulation's token events as the net balance change for one
 * account.
 *
 * An empty `changes` list is a real answer, not a failure: it means no
 * recognized token event touched the account. It is not proof the call moves
 * nothing, because a token contract is free to move balances without emitting
 * a SEP-41 event at all, which is why the dialog frames the section as what
 * the simulation reported rather than as a guarantee.
 *
 * @param rawEvents - Base64 `DiagnosticEvent` XDR from the simulation.
 * @param account - The account whose balance changes are wanted.
 * @param networkPassphrase - The active network passphrase.
 * @param tokens - Tokens tracked for the active network.
 * @returns The net changes, outgoing first.
 */
export function summarizeBalanceChanges(
  rawEvents: string[] | undefined,
  account: string,
  networkPassphrase: string,
  tokens: TrackedToken[] = [],
): BalanceChangeSummary {
  if (!rawEvents || rawEvents.length === 0) {
    return EMPTY;
  }

  const tallies = new Map<string, Tally>();
  const sacCache = new Map<string, SacIdentity | null>();
  let partial = rawEvents.length > MAX_EVENTS;

  for (const raw of rawEvents.slice(0, MAX_EVENTS)) {
    const decoded = decodeEvent(raw);
    if (decoded === null) {
      // An event this decoder cannot walk may well be a movement, so the
      // summary must not read as complete.
      partial = true;
      continue;
    }
    if (decoded === 'skip') {
      continue;
    }
    const { contractId, topics, data } = decoded;

    const [kindTopic, ...rest] = topics;
    if (!kindTopic || kindTopic.switch().name !== 'scvSymbol') {
      continue;
    }
    const kind = kindTopic.sym().toString();
    if (!BALANCE_EVENT_KINDS.has(kind)) {
      continue;
    }

    const amount = readAmount(data);
    if (amount === null) {
      partial = true;
      continue;
    }

    const addresses = rest
      .map(topicAddress)
      .filter((value): value is string => value !== null);
    const movement = toMovement(kind, addresses, amount);
    if (!movement) {
      partial = true;
      continue;
    }

    const delta =
      (movement.to === account ? movement.amount : 0n) -
      (movement.from === account ? movement.amount : 0n);
    if (delta === 0n) {
      continue;
    }

    const existing = tallies.get(contractId);
    if (existing) {
      existing.delta += delta;
      continue;
    }
    if (tallies.size >= MAX_BALANCE_ASSETS) {
      partial = true;
      continue;
    }
    const trailing = rest[rest.length - 1];
    const assetTopic =
      trailing && trailing.switch().name === 'scvString'
        ? trailing.str().toString()
        : null;
    const { label, identity, decimals } = resolveAsset(
      assetTopic,
      contractId,
      networkPassphrase,
      tokens,
      sacCache,
    );
    tallies.set(contractId, { label, identity, decimals, delta });
  }

  // Outgoing first: what the transaction takes is the part a user needs to
  // read before what it gives, and a drain disguised as a swap shows its
  // debit at the top of the section rather than below a list of credits.
  const changes = [...tallies.values()]
    .filter((tally) => tally.delta !== 0n)
    .sort((left, right) => Number(left.delta > 0n) - Number(right.delta > 0n))
    .map(({ label, identity, decimals, delta }) => ({
      asset: label,
      identity,
      amount:
        delta > 0n
          ? `+${formatTokenAmount(delta, decimals ?? 0)}`
          : formatTokenAmount(delta, decimals ?? 0),
      rawUnits: decimals === null,
    }));

  return { changes, partial };
}
