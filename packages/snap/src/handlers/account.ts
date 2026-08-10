import { getWalletAddress } from '../keys';
import { invalidRequest } from '../rpc/errors';
import { OptionalAddressParams, validate } from '../rpc/validation';
import { getActiveNetwork, isOriginConnected } from '../state';
import type { AccountSummary } from '../stellar/horizon';
import { getAccountSummary, requestFriendbot } from '../stellar/horizon';

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
 * `getBalances` — account balances and sequence from Horizon.
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
  return { address, ...summary };
}
