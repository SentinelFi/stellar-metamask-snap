import type { SnapComponent } from '@metamask/snaps-sdk/jsx';
import {
  Bold,
  Box,
  Button,
  Copyable,
  Field,
  Form,
  Heading,
  Input,
  Row,
  Section,
  Text,
} from '@metamask/snaps-sdk/jsx';

import { getOwnedAccounts } from '../keys';
import type { TrackedToken } from '../state';
import { getState } from '../state';
import type { NetworkName } from '../state/networks';
import { NETWORKS } from '../state/networks';
import type { AccountSummary, HorizonBalance } from '../stellar/horizon';
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

/** Form name for the account lookup (`onUserInput` form submission). */
export const FIND_ACCOUNT_FORM = 'find-account';

/** Input name inside {@link FIND_ACCOUNT_FORM}. */
export const FIND_ACCOUNT_INPUT = 'find-account-query';

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
  /**
   * Account addresses could not be derived, so the account section is empty
   * for a reason that is not "you have no accounts". Stated rather than shown
   * as an empty list, for the same reason `tokensUnavailable` exists on the
   * RPC side: an absence the user cannot distinguish from a fact is worse than
   * an error message.
   */
  accountsUnavailable?: boolean;
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
 * @param props.accountsUnavailable - Account addresses could not be derived.
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
  accountsUnavailable,
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
      {accountsUnavailable ? (
        <Text>
          Your address could not be derived just now. The connected sites and
          tracked tokens below are read from stored settings and can still be
          managed; reopen this page to retry.
        </Text>
      ) : (
        <Box>
          <Text>Address</Text>
          <Copyable value={address} />
        </Box>
      )}
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
      {/* Reaching an account you already hold in another SEP-0005 wallet
          used to mean clicking "Add account" once per index. Looking it up
          by address (or by index, when you know it) gets there in one
          step. */}
      <Form name={FIND_ACCOUNT_FORM}>
        <Field label="Find an account by address or index">
          <Input
            name={FIND_ACCOUNT_INPUT}
            placeholder="G… address, or an index such as 3"
          />
        </Field>
        <Button type="submit">Find</Button>
      </Form>
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
  // Derivation crosses the sandbox boundary and can fail (a denied or
  // unavailable entropy source). Letting that escape would take the whole page
  // down, and this page is the only place a user can revoke a site's grant or
  // stop tracking a token, neither of which needs a key. So the account section
  // degrades on its own and the rest of the page still renders.
  let accounts: AccountRow[] = [];
  let accountsUnavailable = false;
  try {
    accounts = await getOwnedAccounts(state);
  } catch {
    accountsUnavailable = true;
  }
  const activeIndex = state.activeAccount;
  const address =
    accounts.find((account) => account.index === activeIndex)?.address ?? '';
  const origins = Object.keys(state.origins);
  const tokens = state.tokens?.[network.name] ?? [];

  let summary: AccountSummary | null = null;
  // Without an address there is nothing to look up, and Horizon would be asked
  // for `/accounts/` instead.
  if (address !== '') {
    try {
      summary = await getAccountSummary(network.horizonUrl, address);
    } catch {
      summary = null;
    }
  }

  // Append tracked-token balances (best-effort).
  //
  // Deliberately does NOT claim the token-read budget that the `getBalances`
  // RPC path claims (`takeTokenReadBudget`, ../rpc/limiter.ts). That budget
  // bounds work a *dapp* can drive; this page is reached only by the user
  // opening their own wallet UI, and `onUserInput` re-renders it after their
  // own clicks, so there is no origin to bound. Making it draw on the same
  // pool would only hand a connected dapp a way to blank the balance rows on
  // the page the user checks their wallet with.
  if (summary?.funded) {
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
            : {
                asset: formatTokenAsset(token.symbol, token.contractId),
                balance,
                type: 'soroban',
                contractId: token.contractId,
              };
        }),
      )
    ).filter((entry): entry is HorizonBalance => entry !== null);
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
        accountsUnavailable={accountsUnavailable}
      />
    ),
  };
}
