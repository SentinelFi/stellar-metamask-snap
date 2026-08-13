import { SnapError } from '@metamask/snaps-sdk';
import {
  array,
  is,
  number,
  optional,
  pattern,
  record,
  string,
  type,
} from '@metamask/superstruct';

import { discardBody, readJsonBounded } from './http';
import { externalServiceError } from '../rpc/errors';

export type HorizonBalance = {
  /** `'XLM'` for the native asset, otherwise `CODE:ISSUER`. */
  asset: string;
  balance: string;
};

export type AccountSummary = {
  funded: boolean;
  /** Current sequence number as a string; `null` when unfunded. */
  sequence: string | null;
  balances: HorizonBalance[];
};

/**
 * Horizon responses are endpoint-controlled input: every consumed field is
 * validated at this boundary before it reaches display or submission logic.
 */
const HorizonBalanceStruct = type({
  // eslint-disable-next-line @typescript-eslint/naming-convention
  asset_type: string(),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  asset_code: optional(pattern(string(), /^[A-Za-z0-9]{1,12}$/u)),
  // eslint-disable-next-line @typescript-eslint/naming-convention
  asset_issuer: optional(pattern(string(), /^G[A-Z2-7]{55}$/u)),
  balance: pattern(string(), /^\d{1,30}(\.\d{1,10})?$/u),
});

const HorizonAccountStruct = type({
  sequence: pattern(string(), /^\d{1,30}$/u),
  balances: array(HorizonBalanceStruct),
});

const AccountChecksStruct = type({
  data: optional(record(string(), string())),
  signers: optional(
    array(type({ key: string(), weight: number(), type: string() })),
  ),
  thresholds: optional(
    type({
      // eslint-disable-next-line @typescript-eslint/naming-convention
      low_threshold: number(),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      med_threshold: number(),
      // eslint-disable-next-line @typescript-eslint/naming-convention
      high_threshold: number(),
    }),
  ),
});

/** A 64-character hex transaction hash. */
const TX_HASH_REGEX = /^[0-9a-f]{64}$/iu;

/** Display cap on balance rows (a hostile response cannot flood the UI). */
const MAX_DISPLAY_BALANCES = 100;

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
    balances: body.balances.slice(0, MAX_DISPLAY_BALANCES).map((entry) => ({
      asset:
        entry.asset_type === 'native'
          ? 'XLM'
          : `${entry.asset_code ?? '?'}:${entry.asset_issuer ?? '?'}`,
      balance: entry.balance,
    })),
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
    // the error message.
    const codes = parsed?.extras?.result_codes
      ? ` Result codes: ${JSON.stringify(parsed.extras.result_codes).slice(0, 200)}.`
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
