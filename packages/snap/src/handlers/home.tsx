import type { SnapComponent } from '@metamask/snaps-sdk/jsx';
import {
  Box,
  Copyable,
  Heading,
  Row,
  Section,
  Text,
} from '@metamask/snaps-sdk/jsx';

import { getWalletAddress } from '../keys';
import { getActiveNetwork } from '../state';
import type { NetworkName } from '../state/networks';
import type { AccountSummary } from '../stellar/horizon';
import { getAccountSummary } from '../stellar/horizon';

export type HomePageProps = {
  network: NetworkName;
  address: string;
  /** Null when Horizon could not be reached. */
  summary: AccountSummary | null;
};

/**
 * The snap home page (MetaMask menu → Snaps → Stellar Soroban): active
 * network, wallet address, and balances.
 *
 * @param props - The home page props.
 * @param props.network - The active network name.
 * @param props.address - The wallet's Stellar address.
 * @param props.summary - Account balances, or null when unavailable.
 * @returns The home page content.
 */
const HomePage: SnapComponent<HomePageProps> = ({
  network,
  address,
  summary,
}) => (
  <Box>
    <Heading>Stellar Soroban</Heading>
    <Section>
      <Row label="Network">
        <Text>{network}</Text>
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
  </Box>
);

/**
 * `onHomePage` — renders the home page with a fresh balance lookup.
 * Degrades gracefully when Horizon is unreachable.
 *
 * @returns The home page content.
 */
export async function homePage() {
  const network = await getActiveNetwork();
  const address = await getWalletAddress();

  let summary: AccountSummary | null = null;
  try {
    summary = await getAccountSummary(network.horizonUrl, address);
  } catch {
    summary = null;
  }

  return {
    content: (
      <HomePage network={network.name} address={address} summary={summary} />
    ),
  };
}
