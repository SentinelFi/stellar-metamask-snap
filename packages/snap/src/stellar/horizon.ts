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

type HorizonAccountResponse = {
  sequence: string;
  balances: {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    asset_type: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    asset_code?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    asset_issuer?: string;
    balance: string;
  }[];
};

/**
 * `fetch` wrapper that converts network failures into SEP-43 external
 * service errors.
 *
 * @param url - The URL to fetch.
 * @param init - Optional fetch options.
 * @param service - Service name for the error message.
 * @returns The response.
 */
async function safeFetch(
  url: string,
  init: Parameters<typeof fetch>[1],
  service: string,
) {
  try {
    return await fetch(url, init);
  } catch {
    throw externalServiceError(`Could not reach ${service}.`);
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
  const response = await safeFetch(
    `${horizonUrl}/accounts/${address}`,
    { headers: { accept: 'application/json' } },
    'Horizon',
  );

  if (response.status === 404) {
    return { funded: false, sequence: null, balances: [] };
  }
  if (!response.ok) {
    throw externalServiceError(`Horizon request failed (${response.status}).`);
  }

  const account = (await response.json()) as HorizonAccountResponse;
  return {
    funded: true,
    sequence: account.sequence,
    balances: account.balances.map((entry) => ({
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
  const response = await safeFetch(
    `${horizonUrl}/transactions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ tx: xdr }),
    },
    'Horizon',
  );

  const body = (await response.json().catch(() => null)) as {
    hash?: string;
    // eslint-disable-next-line @typescript-eslint/naming-convention
    extras?: { result_codes?: unknown };
  } | null;

  if (!response.ok || !body?.hash) {
    const codes = body?.extras?.result_codes
      ? ` Result codes: ${JSON.stringify(body.extras.result_codes)}.`
      : '';
    throw externalServiceError(
      `Transaction submission failed (${response.status}).${codes}`,
    );
  }
  return { hash: body.hash };
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
    const response = await fetch(`${horizonUrl}/accounts/${address}`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (response.status === 404) {
      return {
        exists: false,
        memoRequired: false,
        signers: [],
        thresholds: null,
      };
    }
    if (!response.ok) {
      return null;
    }
    const account = (await response.json()) as {
      data?: Record<string, string>;
      signers?: { key: string; weight: number; type: string }[];
      thresholds?: {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        low_threshold: number;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        med_threshold: number;
        // eslint-disable-next-line @typescript-eslint/naming-convention
        high_threshold: number;
      };
    };
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
  const response = await safeFetch(
    `${friendbotUrl}?addr=${encodeURIComponent(address)}`,
    undefined,
    'friendbot',
  );
  if (!response.ok) {
    throw externalServiceError(
      `Friendbot request failed (${response.status}). The account may already be funded.`,
    );
  }
}
