import {
  ensureEntropyBinding,
  getOwnedAccounts,
  getWalletAddress,
} from '../keys';
import { invalidRequest, userRejected } from '../rpc/errors';
import { takeTokenReadBudget } from '../rpc/limiter';
import { clearDialogRejections, recordDialogOpened } from '../rpc/throttle';
import {
  AddTokenParams,
  OptionalAddressParams,
  validate,
} from '../rpc/validation';
import {
  addToken as addTokenToState,
  getActiveNetwork,
  getTokens,
  isOriginConnected,
  MAX_TRACKED_TOKENS,
} from '../state';
import type { AccountSummary, HorizonBalance } from '../stellar/horizon';
import { getAccountSummary, requestFriendbot } from '../stellar/horizon';
import {
  isContractId,
  readTokenBalance,
  readTokenMetadata,
} from '../stellar/token';
import { AddTokenDialog } from '../ui/dialogs';

// Defined next to the state helpers (which enforce it at commit time);
// re-exported here for existing importers.
export { MAX_TRACKED_TOKENS };

/**
 * A `getBalances` result: the classic Horizon balances plus any tracked
 * Soroban token balances.
 *
 * `tokensUnavailable` is present only when the token fan-out was skipped
 * because the global lookup budget denied it. It exists so a caller cannot
 * read the absence of token rows as "this account holds none of the tracked
 * tokens", the same reason `stellar/safety.ts` states outright when a check
 * did not run instead of silently omitting its warning.
 */
export type AccountBalances = AccountSummary & {
  address: string;
  tokensUnavailable?: true;
};

/**
 * Guard for companion-dapp methods: the origin must hold a connection grant
 * belonging to the secret recovery phrase the wallet is currently deriving
 * from.
 *
 * The grant is read twice, on purpose, and the order is the point. The first
 * read is the cheap common case and keeps an origin with no grant at all from
 * costing a key derivation, which is what an ungated caller would otherwise be
 * able to drive. Only once a grant is found does the entropy binding get
 * established, and the second read then observes whatever that reconciliation
 * did: a grant recorded under a different phrase has been cleared by then, so
 * this refuses rather than acting on consent given for another wallet. Several
 * of the methods behind this gate derive nothing at all (`setNetwork`,
 * `addToken`), and the ones that do derive only after passing it, so without
 * the explicit call the reconciliation would run too late to matter here.
 *
 * {@link ensureEntropyBinding} throws when the binding cannot be confirmed,
 * which surfaces as an external-service error rather than a refusal to connect.
 * That distinction is deliberate: the origin's grant may well be valid, and the
 * honest answer is that the wallet cannot currently tell.
 *
 * @param origin - The requesting dapp origin.
 */
export async function assertConnected(origin: string): Promise<void> {
  if (await isOriginConnected(origin)) {
    await ensureEntropyBinding();
    if (await isOriginConnected(origin)) {
      return;
    }
  }
  throw invalidRequest('Origin is not connected. Call requestAccess first.');
}

/**
 * `fund`: request friendbot funding (test networks only). Only the wallet's
 * own accounts may be funded: there is no per-call dialog, so accepting an
 * arbitrary address would let any connected origin drive friendbot traffic
 * to accounts the user never chose. Defaults to the active account; any
 * revealed account's address is accepted.
 *
 * @param origin - The requesting dapp origin.
 * @param params - Optional `{ address }`; must be a wallet account address.
 * @returns The funded address.
 */
export async function fund(
  origin: string,
  params: unknown,
): Promise<{ funded: true; address: string }> {
  await assertConnected(origin);
  const request = validate(params ?? {}, OptionalAddressParams);
  const network = await getActiveNetwork();

  if (!network.friendbotUrl) {
    throw invalidRequest(
      `Friendbot is not available on ${network.name}. Switch to TESTNET or FUTURENET.`,
    );
  }

  let address = await getWalletAddress();
  if (request.address !== undefined && request.address !== address) {
    const owned = await getOwnedAccounts();
    const match = owned.find((entry) => entry.address === request.address);
    if (!match) {
      throw invalidRequest('fund can only target an account of this wallet.');
    }
    address = match.address;
  }
  await requestFriendbot(network.friendbotUrl, address);
  return { funded: true, address };
}

/**
 * Resolves a dapp-requested address to one of the wallet's revealed
 * accounts, failing closed on anything else.
 *
 * @param requested - The dapp-supplied `address` option.
 * @returns The matching owned address.
 * @throws An invalid-request error when the wallet does not hold it.
 */
async function resolveOwnedAddress(requested: string): Promise<string> {
  const owned = await getOwnedAccounts();
  const match = owned.find((entry) => entry.address === requested);
  if (!match) {
    throw invalidRequest(
      'getBalances can only target an account of this wallet.',
    );
  }
  return match.address;
}

/**
 * How long a balance lookup's result (or in-flight promise) is shared.
 * Balances change per ledger (~5 s), so a shorter window would add no
 * freshness — it would only re-run the per-token simulation fan-out.
 */
const BALANCE_CACHE_TTL_MS = 5000;

/** Coalesced balance lookups, keyed by `network address`. */
const balanceCache = new Map<
  string,
  { at: number; promise: Promise<AccountBalances> }
>();

/** Cache entries kept before the oldest is evicted (accounts × networks). */
const MAX_BALANCE_CACHE_ENTRIES = 64;

/** Clears the balance cache. Test hook. */
export function resetBalanceCache(): void {
  balanceCache.clear();
}

/**
 * The uncached body of {@link getBalances}: one Horizon lookup plus one
 * simulation per tracked token.
 *
 * @param network - The active network config.
 * @param address - The resolved wallet account address.
 * @returns The account summary.
 */
async function readBalances(
  network: Awaited<ReturnType<typeof getActiveNetwork>>,
  address: string,
): Promise<AccountBalances> {
  const summary = await getAccountSummary(network.horizonUrl, address);

  // Append tracked-token balances (best-effort; failures are skipped).
  //
  // The fan-out is one simulation per tracked token, so it is the largest
  // amount of outbound work a single RPC call can cause: at the cap that is 30
  // round trips, and the per-origin rate limit permits 15 calls a minute. The
  // coalescing cache in `getBalances` does not bound it either, since it is
  // keyed by address and a connected origin learns every revealed address from
  // `getAccounts`. So the fan-out claims a global, origin-independent budget,
  // which is the only kind that survives subdomain rotation.
  //
  // It claims its own budget rather than the pre-dialog pool. Sharing that
  // pool would mean a wallet tracking 30 tokens exhausts it in four
  // `getBalances` calls, so an ordinary polling dapp would degrade the user's
  // signing dialogs to "safety checks were skipped" purely as a side effect of
  // refreshing balances. See `takeTokenReadBudget` in ../rpc/limiter.ts.
  //
  // Denial omits the token rows rather than failing the call: the classic
  // Horizon balances are already in hand and are the answer to the question
  // that was asked. `tokensUnavailable` marks the omission so a caller cannot
  // read a short list as "this account holds no tokens", which is the same
  // rule the safety warnings follow.
  const tokens = await getTokens(network.name);
  const budgeted = tokens.length === 0 || takeTokenReadBudget(tokens.length);
  const tokenBalances = budgeted
    ? (
        await Promise.all(
          tokens.map(async (token): Promise<HorizonBalance | null> => {
            const balance = await readTokenBalance(
              network,
              token.contractId,
              address,
              token.decimals,
            );
            // `type` and `contractId` are what keep this row distinguishable
            // from a classic `CODE:ISSUER` row. The symbol is contract-reported
            // and attacker-chosen within its charset, so the display string
            // alone cannot be trusted to identify the asset (see `BalanceKind`).
            return balance === null
              ? null
              : {
                  asset: `${token.symbol}:${token.contractId}`,
                  balance,
                  type: 'soroban' as const,
                  contractId: token.contractId,
                };
          }),
        )
      ).filter((entry): entry is HorizonBalance => entry !== null)
    : [];

  return {
    address,
    ...summary,
    balances: [...summary.balances, ...tokenBalances],
    ...(budgeted ? {} : { tokensUnavailable: true as const }),
  };
}

/**
 * `getBalances` — classic Horizon balances plus tracked Soroban token
 * balances (read via simulation) for the active network. Like `fund`, only
 * the wallet's own accounts may be queried: the wallet is not a lookup
 * proxy for arbitrary third-party accounts.
 *
 * Identical lookups within a short window are coalesced onto one in-flight
 * request: each call fans out one simulation per tracked token, so
 * concurrent or rapid-fire calls from a connected origin must share work
 * instead of multiplying it.
 *
 * @param origin - The requesting dapp origin.
 * @param params - Optional `{ address }`; must be a wallet account address.
 * @returns The account summary (`funded: false` when not on-ledger).
 */
export async function getBalances(
  origin: string,
  params: unknown,
): Promise<AccountBalances> {
  await assertConnected(origin);
  const request = validate(params ?? {}, OptionalAddressParams);
  const network = await getActiveNetwork();

  const active = await getWalletAddress();
  const address =
    request.address === undefined || request.address === active
      ? active
      : await resolveOwnedAddress(request.address);

  const key = `${network.name} ${address}`;
  const now = Date.now();
  const cached = balanceCache.get(key);
  if (cached && now - cached.at < BALANCE_CACHE_TTL_MS) {
    return cached.promise;
  }
  if (balanceCache.size >= MAX_BALANCE_CACHE_ENTRIES) {
    const oldest = balanceCache.keys().next().value;
    if (oldest !== undefined) {
      balanceCache.delete(oldest);
    }
  }
  const promise = readBalances(network, address);
  balanceCache.set(key, { at: now, promise });
  // A failure must not be served from cache for the rest of the window.
  promise.catch(() => balanceCache.delete(key));
  return promise;
}

/**
 * `addToken` — track a Soroban token (SAC/SEP-41) for balance display.
 * Reads the token's metadata via simulation and confirms with the user
 * (Freighter-parity method).
 *
 * @param origin - The requesting dapp origin.
 * @param params - `{ contractId, networkPassphrase? }`.
 * @returns The tracked contract ID.
 */
export async function addToken(
  origin: string,
  params: unknown,
): Promise<{ contractId: string; symbol: string; decimals: number }> {
  await assertConnected(origin);
  const request = validate(params, AddTokenParams);
  const network = await getActiveNetwork();

  if (
    request.networkPassphrase !== undefined &&
    request.networkPassphrase !== network.networkPassphrase
  ) {
    throw invalidRequest(`Network mismatch: the wallet is on ${network.name}.`);
  }
  // Redundant with the boundary validation (AddTokenParams), kept as defense
  // in depth: this is the last stop before the ID reaches metadata reads.
  if (!isContractId(request.contractId)) {
    throw invalidRequest('Invalid contract ID.');
  }

  const tracked = await getTokens(network.name);
  const alreadyTracked = tracked.some(
    (entry) => entry.contractId === request.contractId,
  );
  if (!alreadyTracked && tracked.length >= MAX_TRACKED_TOKENS) {
    throw invalidRequest(
      `Token limit reached: at most ${MAX_TRACKED_TOKENS} tracked tokens per network.`,
    );
  }

  // Two simulations run here, before any dialog can gate them, and a contract
  // ID that names no token fails before one ever opens, so the dialog throttle
  // never engages on this path. The per-origin rate limit above is not a bound
  // either: every control keyed on `origin` resets per subdomain, which is the
  // whole reason the global budgets exist (../rpc/limiter.ts). A standing grant
  // is required to get here, so an attacker pays an approved dialog per origin,
  // but that is equally true of `signAuthEntry`'s ledger reads, which claim the
  // budget anyway on the grounds that it bounds total outbound work against
  // shared community infrastructure rather than merely the unauthenticated
  // share of it. Same rule here.
  //
  // The token-read pool rather than the pre-dialog one, for the reason given at
  // `takeTokenReadBudget`: charging contract reads to the pre-dialog pool would
  // let ordinary token traffic degrade the user's own signing dialogs to
  // "checks were skipped". Denial is an error rather than a silent skip,
  // because there is nothing to show the user without the metadata.
  if (!takeTokenReadBudget(2)) {
    throw invalidRequest(
      'Too many token contract reads have run recently. Try again in a minute.',
    );
  }
  const metadata = await readTokenMetadata(network, request.contractId);
  if (!metadata) {
    throw invalidRequest(
      'Could not read the token contract (symbol/decimals). It may not be a token, or the network may be unreachable.',
    );
  }

  recordDialogOpened(origin);
  const approved = await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'confirmation',
      content: (
        <AddTokenDialog
          origin={origin}
          network={network.name}
          contractId={request.contractId}
          symbol={metadata.symbol}
          decimals={metadata.decimals}
        />
      ),
    },
  });
  if (!approved) {
    throw userRejected();
  }
  // An approved dialog breaks the consecutive-rejection chain.
  clearDialogRejections(origin);

  await addTokenToState(network.name, {
    contractId: request.contractId,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
  });
  return { contractId: request.contractId, ...metadata };
}
