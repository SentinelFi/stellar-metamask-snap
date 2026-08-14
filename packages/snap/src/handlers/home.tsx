import type { SnapComponent } from '@metamask/snaps-sdk/jsx';
import {
  Bold,
  Box,
  Button,
  Copyable,
  Heading,
  Row,
  Section,
  Text,
} from '@metamask/snaps-sdk/jsx';

import { getOwnedAccounts } from '../keys';
import type { TrackedToken } from '../state';
import { getState } from '../state';
import type { NetworkName } from '../state/networks';
import { NETWORKS } from '../state/networks';
import type { AccountSummary } from '../stellar/horizon';
import { getAccountSummary } from '../stellar/horizon';
import { readTokenBalance } from '../stellar/token';
import {
  displayOrigin,
  escapeHiddenCharacters,
  formatTokenAsset,
  isOriginDisplayLossy,
  truncate,
} from '../ui/format';

/** Button-name prefix for per-origin disconnect actions (`onUserInput`). */
export const DISCONNECT_PREFIX = 'disconnect:';

/**
 * Button-name prefix for token removal actions (`onUserInput`). The full
 * name is `remove-token:<network>:<contractId>`.
 */
export const REMOVE_TOKEN_PREFIX = 'remove-token:';

/**
 * Button-name prefix for switching the active account (`onUserInput`). The
 * full name is `use-account:<index>`.
 */
export const USE_ACCOUNT_PREFIX = 'use-account:';

/** Button name for revealing the next account (`onUserInput`). */
export const ADD_ACCOUNT_BUTTON = 'add-account';

/** A revealed account, ready for display. */
export type AccountRow = { index: number; address: string };

export type HomePageProps = {
  network: NetworkName;
  address: string;
  /** Null when Horizon could not be reached. */
  summary: AccountSummary | null;
  /** Every revealed account, in index order. */
  accounts: AccountRow[];
  /** The active account's SEP-0005 index. */
  activeIndex: number;
  /** Origins holding a connection grant. */
  origins: string[];
  /** Tokens tracked on the active network. */
  tokens: TrackedToken[];
};

/**
 * The snap home page (MetaMask menu → Snaps → Stellar Soroban): active
 * network, wallet address, and balances.
 *
 * @param props - The home page props.
 * @param props.network - The active network name.
 * @param props.address - The active account's Stellar address.
 * @param props.summary - Account balances, or null when unavailable.
 * @param props.accounts - Every revealed account, in index order.
 * @param props.activeIndex - The active account's SEP-0005 index.
 * @param props.origins - Origins holding a connection grant.
 * @param props.tokens - Tokens tracked on the active network.
 * @returns The home page content.
 */
const HomePage: SnapComponent<HomePageProps> = ({
  network,
  address,
  summary,
  accounts,
  activeIndex,
  origins,
  tokens,
}) => (
  <Box>
    <Heading>Stellar Soroban</Heading>
    <Section>
      <Row label="Network">
        <Text>{network}</Text>
      </Row>
      <Row label="Account">
        <Text>{`Account ${activeIndex}`}</Text>
      </Row>
      <Text>Address</Text>
      <Copyable value={address} />
    </Section>
    <Section>
      {summary === null ? (
        <Text>Balances unavailable — could not reach Horizon.</Text>
      ) : null}
      {summary && !summary.funded ? (
        <Text>
          {`This account is not funded on ${network} yet. It appears on the ledger after receiving XLM.`}
        </Text>
      ) : null}
      {summary?.funded
        ? summary.balances.map((balance) => (
            <Row label={balance.asset}>
              <Text>{balance.balance}</Text>
            </Row>
          ))
        : null}
    </Section>
    <Section>
      <Text>
        <Bold>Accounts</Bold>
      </Text>
      {accounts.map((account) => (
        <Box>
          <Text>
            {`Account ${account.index} (${truncate(account.address)})${
              account.index === activeIndex ? ' (active)' : ''
            }`}
          </Text>
          <Copyable value={account.address} />
          {account.index === activeIndex ? null : (
            <Button name={`${USE_ACCOUNT_PREFIX}${account.index}`}>Use</Button>
          )}
        </Box>
      ))}
      <Button name={ADD_ACCOUNT_BUTTON}>Add account</Button>
    </Section>
    <Section>
      <Text>
        <Bold>Tracked tokens</Bold>
      </Text>
      {tokens.length === 0 ? (
        <Text>No tokens are tracked on this network.</Text>
      ) : (
        tokens.map((token) => (
          <Box>
            <Text>{formatTokenAsset(token.symbol, token.contractId)}</Text>
            <Button
              name={`${REMOVE_TOKEN_PREFIX}${network}:${token.contractId}`}
            >
              Remove
            </Button>
          </Box>
        ))
      )}
    </Section>
    <Section>
      <Text>
        <Bold>Connected sites</Bold>
      </Text>
      {origins.length === 0 ? (
        <Text>No sites are connected.</Text>
      ) : (
        origins.map((origin) => (
          <Box>
            {/* Sanitized like the dialogs; the raw origin stays in the
                button name because it is the disconnect key. */}
            <Text>{displayOrigin(origin)}</Text>
            {isOriginDisplayLossy(origin) ? (
              // Middle truncation can make two long origins display
              // identically; the complete origin must stay reviewable.
              <Copyable value={escapeHiddenCharacters(origin)} />
            ) : null}
            <Button name={`${DISCONNECT_PREFIX}${origin}`}>Disconnect</Button>
          </Box>
        ))
      )}
    </Section>
  </Box>
);

/**
 * `onHomePage` — renders the home page with a fresh balance lookup.
 * Degrades gracefully when Horizon is unreachable.
 *
 * @returns The home page content.
 */
export async function homePage() {
  // One state read for the whole render. Each `getState()` is a separate
  // `snap_manageState` decrypt, and this page needs the network, the active
  // account, the account list, the origins, and the tracked tokens: reading
  // them through four helpers that each re-read state cost four decrypts of
  // the same value, and left the page assembled from four snapshots that
  // could in principle differ.
  const state = await getState();
  const network = NETWORKS[state.network];
  const accounts = await getOwnedAccounts(state);
  const activeIndex = state.activeAccount;
  const address =
    accounts.find((account) => account.index === activeIndex)?.address ?? '';
  const origins = Object.keys(state.origins);
  const tokens = state.tokens?.[network.name] ?? [];

  let summary: AccountSummary | null = null;
  try {
    summary = await getAccountSummary(network.horizonUrl, address);
  } catch {
    summary = null;
  }

  // Append tracked-token balances (best-effort).
  if (summary?.funded) {
    const tokenBalances = (
      await Promise.all(
        tokens.map(async (token) => {
          const balance = await readTokenBalance(
            network,
            token.contractId,
            address,
            token.decimals,
          );
          return balance === null
            ? null
            : {
                asset: formatTokenAsset(token.symbol, token.contractId),
                balance,
              };
        }),
      )
    ).filter(
      (entry): entry is { asset: string; balance: string } => entry !== null,
    );
    summary = {
      ...summary,
      balances: [...summary.balances, ...tokenBalances],
    };
  }

  return {
    content: (
      <HomePage
        network={network.name}
        address={address}
        summary={summary}
        accounts={accounts}
        activeIndex={activeIndex}
        origins={origins}
        tokens={tokens}
      />
    ),
  };
}
