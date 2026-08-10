import {
  Account,
  Address,
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { StellarSnap } from 'stellar-soroban-snap-connector';
import styled from 'styled-components';

import {
  ActionButton,
  ConnectButton,
  InstallFlaskButton,
  ReconnectButton,
  Card,
  SnapLogo,
} from '../components';
import { defaultSnapOrigin } from '../config';
import { useMetaMask, useMetaMaskContext, useRequestSnap } from '../hooks';
import { isLocalSnap, shouldDisplayReconnectButton } from '../utils';

const Container = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  flex: 1;
  margin-top: 7.6rem;
  margin-bottom: 7.6rem;
  ${({ theme }) => theme.mediaQueries.small} {
    padding-left: 2.4rem;
    padding-right: 2.4rem;
    margin-top: 2rem;
    margin-bottom: 2rem;
    width: auto;
  }
`;

const Heading = styled.h1`
  margin-top: 0;
  margin-bottom: 2.4rem;
  text-align: center;
`;

const Span = styled.span`
  color: ${(props) => props.theme.colors.primary?.default};
`;

const Subtitle = styled.p`
  font-size: ${({ theme }) => theme.fontSizes.large};
  font-weight: 500;
  margin-top: 0;
  margin-bottom: 0;
  ${({ theme }) => theme.mediaQueries.small} {
    font-size: ${({ theme }) => theme.fontSizes.text};
  }
`;

const CardContainer = styled.div`
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  justify-content: space-between;
  max-width: 64.8rem;
  width: 100%;
  height: 100%;
  margin-top: 1.5rem;
`;

const Notice = styled.div`
  background-color: ${({ theme }) => theme.colors.background?.alternative};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  color: ${({ theme }) => theme.colors.text?.alternative};
  border-radius: ${({ theme }) => theme.radii.default};
  padding: 2.4rem;
  margin-top: 2.4rem;
  max-width: 60rem;
  width: 100%;

  & > * {
    margin: 0;
  }
  ${({ theme }) => theme.mediaQueries.small} {
    margin-top: 1.2rem;
    padding: 1.6rem;
  }
`;

const Result = styled.pre`
  margin: 0;
  overflow-x: auto;
  font-size: ${({ theme }) => theme.fontSizes.small};
  white-space: pre-wrap;
  word-break: break-all;
`;

const SuccessNotice = styled(Notice)`
  background-color: ${({ theme }) => theme.colors.success?.muted};
  border-color: ${({ theme }) => theme.colors.success?.default};
`;

const ButtonGroup = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
`;

const StatusCard = styled.div`
  display: flex;
  align-items: center;
  gap: 2rem;
  background-color: ${({ theme }) => theme.colors.card?.default};
  border: 1px solid ${({ theme }) => theme.colors.border?.default};
  border-radius: ${({ theme }) => theme.radii.default};
  padding: 1.6rem 2.4rem;
  margin-top: 2.4rem;
  max-width: 64.8rem;
  width: 100%;
  box-shadow: ${({ theme }) => theme.shadows.default};
  ${({ theme }) => theme.mediaQueries.small} {
    padding: 1.2rem 1.6rem;
    gap: 1.2rem;
  }
`;

const StatusInfo = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  font-size: ${({ theme }) => theme.fontSizes.small};
  word-break: break-all;
`;

const StatusLabel = styled.span`
  font-weight: bold;
  margin-right: 0.6rem;
`;

const ErrorMessage = styled.div`
  background-color: ${({ theme }) => theme.colors.error?.muted};
  border: 1px solid ${({ theme }) => theme.colors.error?.default};
  color: ${({ theme }) => theme.colors.error?.alternative};
  border-radius: ${({ theme }) => theme.radii.default};
  padding: 2.4rem;
  margin-bottom: 2.4rem;
  margin-top: 2.4rem;
  max-width: 60rem;
  width: 100%;
  ${({ theme }) => theme.mediaQueries.small} {
    padding: 1.6rem;
    margin-bottom: 1.2rem;
    margin-top: 1.2rem;
    max-width: 100%;
  }
`;

const Index = () => {
  const { provider, error, setError } = useMetaMaskContext();
  const { isFlask, snapsDetected, installedSnap } = useMetaMask();
  const requestSnap = useRequestSnap();
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The connector: a typed SEP-43 client over wallet_invokeSnap.
  const snapClient = useMemo(
    () =>
      provider
        ? new StellarSnap({ snapId: defaultSnapOrigin, provider })
        : null,
    [provider],
  );

  const isMetaMaskReady = isLocalSnap(defaultSnapOrigin)
    ? isFlask
    : snapsDetected;

  type WalletStatus = {
    network: string;
    address: string;
    /** XLM balance; null when unknown (no grant / unfunded lookup failed). */
    xlm: string | null;
    funded: boolean | null;
  };
  const [status, setStatus] = useState<WalletStatus | null>(null);

  /**
   * Refreshes the wallet status strip (network, address, XLM balance) via
   * silent connector calls. Runs on load and after every action.
   */
  const refreshStatus = useCallback(async () => {
    if (!installedSnap || !snapClient) {
      setStatus(null);
      return;
    }
    try {
      const [{ address: value }, details] = await Promise.all([
        snapClient.getAddress(),
        snapClient.getNetworkDetails(),
      ]);
      let xlm: string | null = null;
      let funded: boolean | null = null;
      if (value) {
        setAddress(value);
        try {
          const summary = await snapClient.getBalances();
          funded = summary.funded;
          xlm = summary.funded
            ? (summary.balances.find((line) => line.asset === 'XLM')?.balance ??
              '0')
            : '0';
        } catch {
          // No grant yet — balance stays unknown.
        }
      }
      setStatus({ network: details.network, address: value, xlm, funded });
    } catch {
      setStatus(null);
    }
  }, [installedSnap, snapClient]);

  useEffect(() => {
    refreshStatus().catch(() => null);
  }, [refreshStatus]);

  /**
   * Serializes snap requests (MetaMask shows one dialog at a time), renders
   * the JSON result on success, and routes connector errors to the error box.
   *
   * @param work - The connector call(s) to run.
   * @returns The result, or null on error.
   */
  const run = async <Type,>(
    work: (client: StellarSnap) => Promise<Type>,
  ): Promise<Type | null> => {
    if (busy || !snapClient) {
      return null;
    }
    setBusy(true);
    setResult(null);
    try {
      const value = await work(snapClient);
      setResult(JSON.stringify(value, null, 2));
      await refreshStatus();
      return value;
    } catch (callError) {
      setError(
        callError instanceof Error ? callError : new Error(String(callError)),
      );
      return null;
    } finally {
      setBusy(false);
    }
  };

  const handleRequestAccess = async () => {
    const response = await run(async (client) => client.requestAccess());
    if (response?.address) {
      setAddress(response.address);
    }
  };

  const handleSignPayment = async () =>
    run(async (client) => {
      const details = await client.getNetworkDetails();
      const balances = await client.getBalances();

      // An unfunded account cannot submit anyway; any sequence demonstrates
      // the signing flow.
      const sequence =
        balances.funded && balances.sequence ? balances.sequence : '1';
      const transaction = new TransactionBuilder(
        new Account(address, sequence),
        {
          fee: '100',
          networkPassphrase: details.networkPassphrase,
        },
      )
        .addOperation(
          Operation.payment({
            destination: address,
            asset: Asset.native(),
            amount: '1.5',
          }),
        )
        .addMemo(Memo.text('snap phase-3 demo'))
        .setTimeout(300)
        .build();

      return client.signTransaction(transaction.toXDR());
    });

  const handleSignSoroban = async () =>
    run(async (client) => {
      const details = await client.getNetworkDetails();
      const balances = await client.getBalances();

      // The XLM Stellar Asset Contract address is deterministic per network.
      const contract = Asset.native().contractId(details.networkPassphrase);
      const sequence =
        balances.funded && balances.sequence ? balances.sequence : '1';

      // 1 XLM self-transfer through the SAC — demonstrates the decoded
      // invocation + in-snap simulation review (not meant for submission).
      const transaction = new TransactionBuilder(
        new Account(address, sequence),
        {
          fee: '1000000',
          networkPassphrase: details.networkPassphrase,
        },
      )
        .addOperation(
          Operation.invokeContractFunction({
            contract,
            function: 'transfer',
            args: [
              new Address(address).toScVal(),
              new Address(address).toScVal(),
              xdr.ScVal.scvI128(
                new xdr.Int128Parts({
                  hi: new xdr.Int64(0n),
                  lo: new xdr.Uint64(10000000n),
                }),
              ),
            ],
          }),
        )
        .setTimeout(300)
        .build();

      return client.signTransaction(transaction.toXDR());
    });

  return (
    <Container>
      <Heading>
        <Span>Stellar Soroban</Span> Snap
      </Heading>
      <Subtitle>Phase 3 — connector-powered test bench</Subtitle>
      {installedSnap && (
        <StatusCard>
          <SnapLogo size={56} />
          <StatusInfo>
            <span>
              <StatusLabel>Network</StatusLabel>
              {status?.network ?? '—'}
            </span>
            <span>
              <StatusLabel>Account</StatusLabel>
              {status !== null && status.address !== '' ? (
                status.address
              ) : (
                <i>not connected — use Request access</i>
              )}
            </span>
            <span>
              <StatusLabel>Balance</StatusLabel>
              {status?.xlm !== null && status?.xlm !== undefined
                ? `${status.xlm} XLM${status.funded === false ? ' (account not funded)' : ''}`
                : '—'}
            </span>
          </StatusInfo>
        </StatusCard>
      )}
      <CardContainer>
        {!isMetaMaskReady && (
          <Card
            content={{
              title: 'Install',
              description:
                'Snaps is pre-release software only available in MetaMask Flask, a canary distribution for developers with access to upcoming features.',
              button: <InstallFlaskButton />,
            }}
            fullWidth
          />
        )}
        {!installedSnap && (
          <Card
            content={{
              title: 'Connect',
              description: 'Install the Stellar Soroban snap into MetaMask.',
              button: (
                <ConnectButton
                  onClick={requestSnap}
                  disabled={!isMetaMaskReady}
                />
              ),
            }}
            disabled={!isMetaMaskReady}
          />
        )}
        {shouldDisplayReconnectButton(installedSnap) && (
          <Card
            content={{
              title: 'Reconnect',
              description:
                'While connected to a local running snap this button will always be displayed in order to update the snap if a change is made.',
              button: (
                <ReconnectButton
                  onClick={requestSnap}
                  disabled={!installedSnap}
                />
              ),
            }}
            disabled={!installedSnap}
          />
        )}
        <Card
          content={{
            title: 'Request access',
            description:
              'Connect this origin to the wallet (SEP-43 requestAccess). First call shows a consent dialog.',
            button: (
              <ActionButton
                onClick={handleRequestAccess}
                disabled={!installedSnap || busy}
              >
                Request access
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || busy}
        />
        <Card
          content={{
            title: 'Get address',
            description:
              'Silent read (Freighter semantics): empty string until access is granted.',
            button: (
              <ActionButton
                onClick={async () => run(async (client) => client.getAddress())}
                disabled={!installedSnap || busy}
              >
                Get address
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || busy}
        />
        <Card
          content={{
            title: 'Network',
            description: 'Read network details or switch (dialog-confirmed).',
            button: (
              <ButtonGroup>
                <ActionButton
                  onClick={async () =>
                    run(async (client) => client.getNetworkDetails())
                  }
                  disabled={!installedSnap || busy}
                >
                  Details
                </ActionButton>
                <ActionButton
                  onClick={async () =>
                    run(async (client) => client.setNetwork('TESTNET'))
                  }
                  disabled={!installedSnap || busy}
                >
                  Testnet
                </ActionButton>
                <ActionButton
                  onClick={async () =>
                    run(async (client) => client.setNetwork('FUTURENET'))
                  }
                  disabled={!installedSnap || busy}
                >
                  Futurenet
                </ActionButton>
                <ActionButton
                  onClick={async () =>
                    run(async (client) => client.setNetwork('PUBLIC'))
                  }
                  disabled={!installedSnap || busy}
                >
                  Public (mainnet)
                </ActionButton>
              </ButtonGroup>
            ),
          }}
          disabled={!installedSnap || busy}
        />
        <Card
          content={{
            title: 'Fund (friendbot)',
            description:
              'Fund the wallet account on the active test network. Requires access.',
            button: (
              <ActionButton
                onClick={async () => run(async (client) => client.fund())}
                disabled={!installedSnap || busy}
              >
                Fund
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || busy}
        />
        <Card
          content={{
            title: 'Get balances',
            description:
              'Horizon balances and sequence for the wallet account. Requires access.',
            button: (
              <ActionButton
                onClick={async () =>
                  run(async (client) => client.getBalances())
                }
                disabled={!installedSnap || busy}
              >
                Balances
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || busy}
        />
        <Card
          content={{
            title: 'Sign payment',
            description:
              'Builds a 1.5 XLM self-payment and requests a signature — review the decoded dialog in MetaMask.',
            button: (
              <ActionButton
                onClick={handleSignPayment}
                disabled={!installedSnap || !address || busy}
              >
                Sign payment
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || !address || busy}
        />
        <Card
          content={{
            title: 'Sign Soroban invoke',
            description:
              'Builds an XLM contract (SAC) transfer invocation — review the decoded call and in-snap simulation in MetaMask.',
            button: (
              <ActionButton
                onClick={handleSignSoroban}
                disabled={!installedSnap || !address || busy}
              >
                Sign Soroban invoke
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || !address || busy}
        />
        <Card
          content={{
            title: 'Sign message',
            description: 'SEP-53 message signature over a demo string.',
            button: (
              <ActionButton
                onClick={async () =>
                  run(async (client) =>
                    client.signMessage('Hello from the Stellar Soroban Snap!'),
                  )
                }
                disabled={!installedSnap || busy}
              >
                Sign message
              </ActionButton>
            ),
          }}
          disabled={!installedSnap || busy}
        />
        {error && (
          <ErrorMessage>
            <b>An error happened:</b> {error.message}
          </ErrorMessage>
        )}
        {result && (
          <SuccessNotice>
            <Result>{result}</Result>
          </SuccessNotice>
        )}
        <Notice>
          <p>
            Sign payment requires access first (it needs your address). Expected
            address for the published SEP-0005 test mnemonic (&ldquo;illness
            spike retreat&hellip;&rdquo;):{' '}
            <b>GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6</b>.
          </p>
        </Notice>
      </CardContainer>
    </Container>
  );
};

export default Index;
