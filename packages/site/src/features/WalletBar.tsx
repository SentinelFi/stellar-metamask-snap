import type { NetworkName } from 'stellar-soroban-snap-connector';
import styled from 'styled-components';

import { Button, Select } from '../components/Form';
import { Cluster } from '../components/Layout';
import { AddressChip, Badge, ExternalLink } from '../components/Status';
import { useWallet } from '../hooks';
import { explorerAccountUrl, formatAmount, handle } from '../utils';

const Bar = styled.section`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1.6rem 2.4rem;
  padding: 1.6rem 2.4rem;
  background-color: ${({ theme }) => theme.colors.card?.default};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: ${({ theme }) => theme.radii.default};
  box-shadow: ${({ theme }) => theme.shadows.panel};
  ${({ theme }) => theme.mediaQueries.small} {
    padding: 1.2rem 1.6rem;
  }
`;

const Group = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
`;

const GroupLabel = styled.span`
  font-size: ${({ theme }) => theme.fontSizes.tiny};
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${({ theme }) => theme.colors.text?.muted};
`;

const Amount = styled.span`
  font-size: ${({ theme }) => theme.fontSizes.title};
  font-weight: 600;
  line-height: 1.1;
`;

const AmountUnit = styled.span`
  font-size: ${({ theme }) => theme.fontSizes.small};
  color: ${({ theme }) => theme.colors.text?.muted};
  margin-left: 0.6rem;
`;

const NetworkSelect = styled(Select)`
  width: auto;
  padding: 0.6rem 1rem;
  min-height: 3.2rem;
`;

const NETWORKS: NetworkName[] = ['TESTNET', 'FUTURENET', 'PUBLIC'];

/**
 * The account strip: network, active account, native balance, and the two
 * actions that get a fresh wallet usable (grant access, fund on a test
 * network).
 *
 * @returns The wallet bar.
 */
export const WalletBar = () => {
  const {
    ready,
    busy,
    address,
    connected,
    network,
    accounts,
    activeIndex,
    balances,
    run,
  } = useWallet();

  if (!ready) {
    return null;
  }

  const nativeBalance = balances?.balances.find(
    (line) => line.type === 'native',
  );
  const explorer =
    network && address ? explorerAccountUrl(network.network, address) : null;
  const isTestNetwork = network !== null && network.network !== 'PUBLIC';

  /**
   * Switches the wallet-global network. Mainnet gets a blocking prompt of
   * its own before the snap's dialog: this page is a demo bench, and a stray
   * click should not even reach a dialog that moves the wallet onto real
   * funds.
   *
   * @param next - The network to switch to.
   */
  const changeNetwork = async (next: NetworkName) => {
    if (next === network?.network) {
      return;
    }
    if (
      next === 'PUBLIC' &&
      // eslint-disable-next-line no-alert -- A blocking prompt is the point: this moves the wallet onto real funds.
      !window.confirm(
        'Switch the wallet-global network to PUBLIC (mainnet)? ' +
          'Transactions signed there move real funds.',
      )
    ) {
      return;
    }
    await run(async (client) => client.setNetwork(next));
  };

  return (
    <Bar>
      <Group>
        <GroupLabel>Network</GroupLabel>
        <Cluster gap="0.8rem">
          <NetworkSelect
            value={network?.network ?? 'TESTNET'}
            disabled={busy}
            aria-label="Network"
            onChange={handle(async (event) =>
              changeNetwork(event.target.value as NetworkName),
            )}
          >
            {NETWORKS.map((name) => (
              <option key={name} value={name}>
                {name === 'PUBLIC' ? 'PUBLIC (mainnet)' : name}
              </option>
            ))}
          </NetworkSelect>
          {network?.network === 'PUBLIC' ? (
            <Badge tone="warning">Real funds</Badge>
          ) : (
            <Badge tone="accent">Test network</Badge>
          )}
        </Cluster>
      </Group>

      <Group>
        <GroupLabel>Account</GroupLabel>
        {connected ? (
          <Cluster gap="0.8rem">
            {accounts.length > 1 ? (
              <NetworkSelect
                value={String(activeIndex)}
                disabled={busy}
                aria-label="Active account"
                onChange={handle(async (event) =>
                  run(async (client) =>
                    client.setActiveAccount(Number(event.target.value)),
                  ),
                )}
              >
                {accounts.map((account) => (
                  <option key={account.index} value={account.index}>
                    {`Account ${account.index}`}
                  </option>
                ))}
              </NetworkSelect>
            ) : (
              <Badge>{`Account ${activeIndex}`}</Badge>
            )}
            <AddressChip value={address} />
            {explorer ? (
              <ExternalLink href={explorer}>Explorer</ExternalLink>
            ) : null}
          </Cluster>
        ) : (
          <Button
            variant="primary"
            disabled={busy}
            onClick={handle(async () =>
              run(async (client) => client.requestAccess()),
            )}
          >
            Connect wallet
          </Button>
        )}
      </Group>

      <Group>
        <GroupLabel>Balance</GroupLabel>
        <Cluster gap="1.2rem">
          <span>
            <Amount>
              {nativeBalance ? formatAmount(nativeBalance.balance) : '—'}
            </Amount>
            <AmountUnit>XLM</AmountUnit>
          </span>
          {connected && balances?.funded === false ? (
            <Badge tone="warning">Not funded</Badge>
          ) : null}
          {connected && isTestNetwork ? (
            <Button
              small
              disabled={busy}
              onClick={handle(async () => run(async (client) => client.fund()))}
            >
              Fund
            </Button>
          ) : null}
        </Cluster>
      </Group>
    </Bar>
  );
};
