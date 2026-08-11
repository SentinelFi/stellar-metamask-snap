import { getWalletAddress } from '../keys';
import { invalidRequest, userRejected } from '../rpc/errors';
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
} from '../state';
import type { AccountSummary, HorizonBalance } from '../stellar/horizon';
import { getAccountSummary, requestFriendbot } from '../stellar/horizon';
import {
  isContractId,
  readTokenBalance,
  readTokenMetadata,
} from '../stellar/token';
import { AddTokenDialog } from '../ui/dialogs';

/**
 * Cap on tracked tokens per network — every tracked token adds a simulation
 * round-trip to `getBalances` and each home-page render. Tokens can be
 * removed from the snap home page, so the cap is housekeeping, not a wall.
 */
export const MAX_TRACKED_TOKENS = 30;

/**
 * Guard for companion-dapp methods: the origin must hold a connection grant.
 *
 * @param origin - The requesting dapp origin.
 */
async function assertConnected(origin: string): Promise<void> {
  if (!(await isOriginConnected(origin))) {
    throw invalidRequest('Origin is not connected. Call requestAccess first.');
  }
}

/**
 * `fund` — request friendbot funding (test networks only).
 *
 * @param origin - The requesting dapp origin.
 * @param params - Optional `{ address }`; defaults to the wallet address.
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

  const address = request.address ?? (await getWalletAddress());
  await requestFriendbot(network.friendbotUrl, address);
  return { funded: true, address };
}

/**
 * `getBalances` — classic Horizon balances plus tracked Soroban token
 * balances (read via simulation) for the active network.
 *
 * @param origin - The requesting dapp origin.
 * @param params - Optional `{ address }`; defaults to the wallet address.
 * @returns The account summary (`funded: false` when not on-ledger).
 */
export async function getBalances(
  origin: string,
  params: unknown,
): Promise<AccountSummary & { address: string }> {
  await assertConnected(origin);
  const request = validate(params ?? {}, OptionalAddressParams);
  const network = await getActiveNetwork();

  const address = request.address ?? (await getWalletAddress());
  const summary = await getAccountSummary(network.horizonUrl, address);

  // Append tracked-token balances (best-effort; failures are skipped).
  const tokens = await getTokens(network.name);
  const tokenBalances = (
    await Promise.all(
      tokens.map(async (token): Promise<HorizonBalance | null> => {
        const balance = await readTokenBalance(
          network,
          token.contractId,
          address,
          token.decimals,
        );
        return balance === null
          ? null
          : { asset: `${token.symbol}:${token.contractId}`, balance };
      }),
    )
  ).filter((entry): entry is HorizonBalance => entry !== null);

  return {
    address,
    ...summary,
    balances: [...summary.balances, ...tokenBalances],
  };
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

  const metadata = await readTokenMetadata(network, request.contractId);
  if (!metadata) {
    throw invalidRequest(
      'Could not read the token contract (symbol/decimals). It may not be a token, or the network may be unreachable.',
    );
  }

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

  await addTokenToState(network.name, {
    contractId: request.contractId,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
  });
  return { contractId: request.contractId, ...metadata };
}
