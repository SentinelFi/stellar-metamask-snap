import { SnapError } from '@metamask/snaps-sdk';
import {
  array,
  enums,
  is,
  number,
  optional,
  pattern,
  record,
  refine,
  string,
  type,
} from '@metamask/superstruct';

import { discardBody, readJsonBounded } from './http';
import { LedgerSequenceStruct } from './ledger';
import { externalServiceError } from '../rpc/errors';
import { sanitizeInlineText } from '../ui/format';

/**
 * What kind of asset a balance row describes.
 *
 * This exists because {@link HorizonBalance.asset} cannot carry the
 * distinction. Classic assets render as `CODE:ISSUER`, and tracked Soroban
 * tokens are appended to the same array in the same shape
 * (`SYMBOL:CONTRACT_ID`, see `handlers/account.tsx`), so a consumer splitting
 * on `:` and displaying the first field, the obvious reading of that
 * convention, shows a contract-reported symbol as though it were an issued
 * asset code. The symbol is chosen by whoever wrote the contract, so `USDC`
 * from a contract the user was merely persuaded to track is indistinguishable
 * from `USDC` issued on the ledger; only the leading character of the second
 * field differs, and no display layer is obliged to notice that.
 *
 * The snap's own home page already avoids this by rendering tokens through
 * `formatTokenAsset` (symbol plus truncated contract) rather than the
 * colon form. This field carries the same distinction across the RPC boundary,
 * so a dapp does not have to reverse-engineer it from the string.
 */
export type BalanceKind = 'native' | 'classic' | 'soroban' | 'pool';

export type HorizonBalance = {
  /**
   * `'XLM'` for the native asset, `CODE:ISSUER` for an issued asset,
   * `SYMBOL:CONTRACT_ID` for a tracked token, and `Pool shares:POOL_ID` for
   * liquidity-pool shares.
   */
  asset: string;
  balance: string;
  /**
   * Which kind of asset this row describes. Consumers that render an asset
   * name should branch on this rather than parsing {@link HorizonBalance.asset}.
   */
  type: BalanceKind;
  /**
   * The token contract, present only on `soroban` rows. Carried separately so
   * a consumer never has to recover it by splitting the display string.
   */
  contractId?: string;
};

export type AccountSummary = {
  funded: boolean;
  /** Current sequence number as a string; `null` when unfunded. */
  sequence: string | null;
  balances: HorizonBalance[];
  /**
   * Present (and always `true`) when Horizon reported more balances than the
   * display cap and the list was cut. Without it, "asset absent from the
   * list" and "asset not held" read identically, and a legitimate account
   * can hold more trustlines than the cap: partial coverage must never be
   * mistaken for complete holdings, the same rule the token-read and safety
   * layers already follow.
   */
  balancesTruncated?: true;
};

/** The balance row shapes Horizon emits, by `asset_type`. */
const BALANCE_ASSET_TYPES = [
  'native',
  'credit_alphanum4',
  'credit_alphanum12',
  'liquidity_pool_shares',
] as const;

/**
 * Horizon responses are endpoint-controlled input: every consumed field is
 * validated at this boundary before it reaches display or submission logic.
 *
 * The identifying fields are required per row kind, not merely optional: an
 * issued-asset row must carry its code and issuer and a pool-share row its
 * pool ID, or the row does not identify an asset at all. A permissive shape
 * here would accept such a row and the mapper below would then have to label
 * it with placeholders, which is the opposite of validating at the boundary.
 * An `asset_type` outside the closed set Horizon defines is refused the same
 * way, so a new or unexpected kind cannot be rendered under a wrong label.
 */
const HorizonBalanceStruct = refine(
  type({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    asset_type: enums(BALANCE_ASSET_TYPES),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    asset_code: optional(pattern(string(), /^[A-Za-z0-9]{1,12}$/u)),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    asset_issuer: optional(pattern(string(), /^G[A-Z2-7]{55}$/u)),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    liquidity_pool_id: optional(pattern(string(), /^[0-9a-f]{64}$/u)),
    balance: pattern(string(), /^\d{1,30}(\.\d{1,10})?$/u),
  }),
  'HorizonBalance',
  (row) => {
    if (row.asset_type === 'liquidity_pool_shares') {
      return (
        row.liquidity_pool_id !== undefined ||
        'A pool-share balance must name its pool.'
      );
    }
    if (row.asset_type !== 'native') {
      return (
        (row.asset_code !== undefined && row.asset_issuer !== undefined) ||
        'An issued-asset balance must carry its code and issuer.'
      );
    }
    return true;
  },
);

const HorizonAccountStruct = type({
  sequence: pattern(string(), /^\d{1,30}$/u),
  balances: array(HorizonBalanceStruct),
});

/**
 * The account fields the safety checks consume. `signers` and `thresholds`
 * are required: Horizon always returns both for an account that exists, and
 * a `200` whose body lacks them (an intermediary answering with some other
 * JSON object, a broken endpoint) must degrade to "unchecked" and be
 * disclosed as such, not parse into an account with no signers and no
 * thresholds that silently passes the weight check. `data` is genuinely
 * optional: Horizon omits it when the account has no data entries.
 */
const AccountChecksStruct = type({
  data: optional(record(string(), string())),
  signers: array(type({ key: string(), weight: number(), type: string() })),
  thresholds: type({
    // eslint-disable-next-line @typescript-eslint/naming-convention
    low_threshold: number(),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    med_threshold: number(),
    // eslint-disable-next-line @typescript-eslint/naming-convention
    high_threshold: number(),
  }),
});

/** A 64-character hex transaction hash. */
const TX_HASH_REGEX = /^[0-9a-f]{64}$/iu;

/**
 * Display cap on balance rows (a hostile response cannot flood the UI).
 * Exported so the home page can say how many rows the cap kept when it
 * discloses a truncation.
 */
export const MAX_DISPLAY_BALANCES = 100;

/** Default abort timeout for Horizon/friendbot requests (ms). */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * `fetch` wrapper that applies an abort timeout covering both the header
 * phase and the body read, refuses redirects (a 307/308 must not move
 * signing-related payloads to another host), and converts network failures
 * into SEP-43 external service errors, so a slow endpoint cannot hold a
 * request open until the manifest's `maxRequestTime` expires.
 *
 * @param url - The URL to fetch.
 * @param init - Optional fetch options.
 * @param service - Service name for the error message.
 * @param timeoutMs - Abort timeout in milliseconds.
 * @returns The response status flags and parsed JSON body (null when the
 * body is not valid JSON).
 */
async function safeFetchJson(
  url: string,
  init: Parameters<typeof fetch>[1],
  service: string,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    const body: unknown = await readJsonBounded(response, service);
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    // readJsonBounded throws a typed oversized-response error; keep it.
    if (error instanceof SnapError) {
      throw error;
    }
    throw externalServiceError(`Could not reach ${service}.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetches an account's balances and sequence from Horizon.
 *
 * @param horizonUrl - The Horizon base URL for the active network.
 * @param address - The `G...` account to look up.
 * @returns The account summary; `funded: false` when the account does not
 * exist on the ledger yet.
 */
export async function getAccountSummary(
  horizonUrl: string,
  address: string,
): Promise<AccountSummary> {
  const { ok, status, body } = await safeFetchJson(
    `${horizonUrl}/accounts/${encodeURIComponent(address)}`,
    { headers: { accept: 'application/json' } },
    'Horizon',
  );

  if (status === 404) {
    return { funded: false, sequence: null, balances: [] };
  }
  if (!ok) {
    throw externalServiceError(`Horizon request failed (${status}).`);
  }

  if (!is(body, HorizonAccountStruct)) {
    throw externalServiceError('Malformed Horizon account response.');
  }
  return {
    funded: true,
    sequence: body.sequence,
    balances: body.balances.slice(0, MAX_DISPLAY_BALANCES).map((entry) => {
      if (entry.asset_type === 'native') {
        return {
          asset: 'XLM',
          balance: entry.balance,
          type: 'native' as const,
        };
      }
      if (entry.asset_type === 'liquidity_pool_shares') {
        // Pool shares have no code or issuer; the pool ID is their identity.
        // The struct above guarantees the ID is present for this kind.
        return {
          asset: `Pool shares:${entry.liquidity_pool_id ?? ''}`,
          balance: entry.balance,
          type: 'pool' as const,
        };
      }
      // The struct guarantees both fields for an issued asset.
      return {
        asset: `${entry.asset_code ?? ''}:${entry.asset_issuer ?? ''}`,
        balance: entry.balance,
        type: 'classic' as const,
      };
    }),
    // The cap is a defense against a flooding response, but cutting the list
    // silently would present the first rows as complete holdings.
    ...(body.balances.length > MAX_DISPLAY_BALANCES
      ? { balancesTruncated: true as const }
      : {}),
  };
}

/**
 * Submits a signed transaction envelope to Horizon (synchronous endpoint).
 *
 * @param horizonUrl - The Horizon base URL for the active network.
 * @param xdr - The signed base64 TransactionEnvelope.
 * @returns The network transaction hash.
 */
export async function submitTransaction(
  horizonUrl: string,
  xdr: string,
): Promise<{ hash: string }> {
  const { ok, status, body } = await safeFetchJson(
    `${horizonUrl}/transactions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: xdr }),
    },
    'Horizon',
  );

  const parsed = body as {
    hash?: unknown;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    extras?: { result_codes?: unknown };
  } | null;

  const hash =
    typeof parsed?.hash === 'string' && TX_HASH_REGEX.test(parsed.hash)
      ? parsed.hash
      : null;
  if (!ok || !hash) {
    // The result codes are endpoint-controlled: bound what gets echoed into
    // the error message, and strip hidden/direction-altering characters.
    // `JSON.stringify` escapes controls but leaves format characters (bidi
    // overrides, zero-width marks) raw, and this string reaches whatever
    // surface the dapp renders its errors on.
    const codes = parsed?.extras?.result_codes
      ? ` Result codes: ${sanitizeInlineText(
          JSON.stringify(parsed.extras.result_codes),
        ).slice(0, 200)}.`
      : '';
    throw externalServiceError(
      `Transaction submission failed (${status}).${codes}`,
    );
  }
  return { hash };
}

export type AccountChecks = {
  exists: boolean;
  /** SEP-29: the account carries a `config.memo_required` data entry. */
  memoRequired: boolean;
  /** Ed25519 signers with weights (present when the account exists). */
  signers: { key: string; weight: number }[];
  /** Operation thresholds (present when the account exists). */
  thresholds: { low: number; med: number; high: number } | null;
};

/**
 * Fetches display-safety facts about an account (existence, SEP-29 memo
 * requirement, signers/thresholds). Best-effort: returns null when Horizon
 * cannot be reached in time — callers degrade gracefully.
 *
 * @param horizonUrl - The Horizon base URL for the active network.
 * @param address - The account to check.
 * @param timeoutMs - Bounded lookup time.
 * @returns The checks, or null when unavailable.
 */
export async function getAccountChecks(
  horizonUrl: string,
  address: string,
  timeoutMs = 5000,
): Promise<AccountChecks | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `${horizonUrl}/accounts/${encodeURIComponent(address)}`,
      {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal,
      },
    );
    if (response.status === 404) {
      // Nothing to read, but the body must still be released while the abort
      // timer is armed.
      await discardBody(response);
      return {
        exists: false,
        memoRequired: false,
        signers: [],
        thresholds: null,
      };
    }
    if (!response.ok) {
      await discardBody(response);
      return null;
    }
    // Bounded read: an oversized body throws and degrades to null below.
    const account: unknown = await readJsonBounded(response, 'Horizon');
    if (!is(account, AccountChecksStruct)) {
      // Best-effort checks: a malformed response degrades to "unknown"
      // rather than feeding unvalidated data into safety warnings.
      return null;
    }
    return {
      exists: true,
      memoRequired: Boolean(account.data?.['config.memo_required']),
      signers: (account.signers ?? [])
        .filter((signer) => signer.type === 'ed25519_public_key')
        .map(({ key, weight }) => ({ key, weight })),
      thresholds: account.thresholds
        ? {
            low: account.thresholds.low_threshold,
            med: account.thresholds.med_threshold,
            high: account.thresholds.high_threshold,
          }
        : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The Horizon root fields consumed by {@link getHorizonLatestLedger}. */
const HorizonRootStruct = type({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  core_latest_ledger: LedgerSequenceStruct,
});

/**
 * Fetches the network's latest ledger sequence from Horizon's root endpoint.
 *
 * Exists as an independent second source for ledger height: the Soroban RPC
 * also reports it, but on PUBLIC that RPC is a third-party gateway, and the
 * ledger height bounds how long an authorization signature stays valid. A
 * single source that inflates the height could stretch a "five minute"
 * default authorization far beyond what the dialog discloses; callers
 * cross-check by taking the minimum of the sources they can reach.
 *
 * Best-effort: returns null when Horizon cannot be reached or answers with
 * an unexpected shape, so callers decide how to degrade.
 *
 * @param horizonUrl - The Horizon base URL for the active network.
 * @returns The latest ledger sequence, or null when unavailable.
 */
export async function getHorizonLatestLedger(
  horizonUrl: string,
): Promise<number | null> {
  try {
    const { ok, body } = await safeFetchJson(
      `${horizonUrl}/`,
      { headers: { accept: 'application/json' } },
      'Horizon',
    );
    if (!ok || !is(body, HorizonRootStruct)) {
      return null;
    }
    return body.core_latest_ledger;
  } catch {
    return null;
  }
}

/**
 * Requests testnet/futurenet funding from friendbot.
 *
 * @param friendbotUrl - The friendbot base URL.
 * @param address - The account to fund.
 */
export async function requestFriendbot(
  friendbotUrl: string,
  address: string,
): Promise<void> {
  const { ok, status } = await safeFetchJson(
    `${friendbotUrl}?addr=${encodeURIComponent(address)}`,
    undefined,
    'friendbot',
  );
  if (!ok) {
    throw externalServiceError(
      `Friendbot request failed (${status}). The account may already be funded.`,
    );
  }
}
