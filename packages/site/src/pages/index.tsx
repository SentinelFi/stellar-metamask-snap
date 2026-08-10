import {
  Account,
  Address,
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import { useEffect, useState } from 'react';
import styled from 'styled-components';

import {
  ActionButton,
  ConnectButton,
  InstallFlaskButton,
  ReconnectButton,
  Card,
} from '../components';
import { defaultSnapOrigin } from '../config';
import {
  useMetaMask,
  useInvokeSnap,
  useMetaMaskContext,
  useRequestSnap,
} from '../hooks';
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
  const { error } = useMetaMaskContext();
  const { isFlask, snapsDetected, installedSnap } = useMetaMask();
  const requestSnap = useRequestSnap();
  const invokeSnap = useInvokeSnap();
  const [address, setAddress] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isMetaMaskReady = isLocalSnap(defaultSnapOrigin)
    ? isFlask
    : snapsDetected;

  // If this origin already holds a grant, the silent getAddress recovers the
  // address after a page reload (no dialog for ungranted origins — it just
  // returns an empty string).
  useEffect(() => {
    if (!installedSnap) {
      return;
    }
    invokeSnap({ method: 'getAddress' })
      .then((response) => {
        const value = (response as { address?: string } | null)?.address;
        if (value) {
          setAddress(value);
        }
        return null;
      })
      .catch(() => null);
  }, [installedSnap]);

  /**
   * Serializes snap requests: MetaMask shows one dialog at a time, so the
   * test bench disables actions while a request is in flight rather than
   * stacking a second call (which the snap would reject as an internal
   * error).
   *
   * @param work - The async request(s) to run.
   * @returns The work's result.
   */
  const run = async <Type,>(
    work: () => Promise<Type>,
  ): Promise<Type | null> => {
    if (busy) {
      return null;
    }
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  };

  /**
   * Invokes a snap method and renders the JSON result.
   *
   * @param method - The RPC method name.
   * @param params - Optional params.
   * @returns The parsed result, or null on error/rejection.
   */
  const call = async (method: string, params?: Record<string, unknown>) =>
    run(async () => {
      setResult(null);
      const response = await invokeSnap(
        params ? { method, params } : { method },
      );
      if (response !== null) {
        setResult(JSON.stringify(response, null, 2));
      }
      return response as Record<string, unknown> | null;
    });

  const handleRequestAccess = async () => {
    const response = await call('requestAccess');
    if (response && typeof response.address === 'string') {
      setAddress(response.address);
    }
  };

  const handleSignPayment = async () =>
    run(async () => {
      setResult(null);
      const details = (await invokeSnap({
        method: 'getNetworkDetails',
      })) as { networkPassphrase: string } | null;
      const balances = (await invokeSnap({ method: 'getBalances' })) as {
        funded: boolean;
        sequence: string | null;
      } | null;
      if (!details || !balances) {
        return null;
      }

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
        .addMemo(Memo.text('snap phase-1 demo'))
        .setTimeout(300)
        .build();

      const response = await invokeSnap({
        method: 'signTransaction',
        params: { xdr: transaction.toXDR() },
      });
      if (response !== null) {
        setResult(JSON.stringify(response, null, 2));
      }
      return null;
    });

  const handleSignSoroban = async () =>
    run(async () => {
      setResult(null);
      const details = (await invokeSnap({
        method: 'getNetworkDetails',
      })) as { networkPassphrase: string } | null;
      const balances = (await invokeSnap({ method: 'getBalances' })) as {
        funded: boolean;
        sequence: string | null;
      } | null;
      if (!details || !balances) {
        return null;
      }

      // The XLM Stellar Asset Contract address is deterministic per network.
      const contract = Asset.native().contractId(details.networkPassphrase);
      const sequence =
        balances.funded && balances.sequence ? balances.sequence : '1';

      // 1 XLM self-transfer through the SAC — demonstrates the decoded
      // invocation + in-snap simulation review (not meant for submission;
      // the envelope is not simulation-assembled).
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

      const response = await invokeSnap({
        method: 'signTransaction',
        params: { xdr: transaction.toXDR() },
      });
      if (response !== null) {
        setResult(JSON.stringify(response, null, 2));
      }
      return null;
    });

  return (
    <Container>
      <Heading>
        <Span>Stellar Soroban</Span> Snap
      </Heading>
      <Subtitle>Phase 1 — SEP-43 wallet API test bench</Subtitle>
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
                onClick={async () => call('getAddress')}
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
              <>
                <ActionButton
                  onClick={async () => call('getNetworkDetails')}
                  disabled={!installedSnap || busy}
                >
                  Details
                </ActionButton>
                <ActionButton
                  onClick={async () =>
                    call('setNetwork', { network: 'TESTNET' })
                  }
                  disabled={!installedSnap || busy}
                >
                  Testnet
                </ActionButton>
                <ActionButton
                  onClick={async () =>
                    call('setNetwork', { network: 'FUTURENET' })
                  }
                  disabled={!installedSnap || busy}
                >
                  Futurenet
                </ActionButton>
                <ActionButton
                  onClick={async () =>
                    call('setNetwork', { network: 'PUBLIC' })
                  }
                  disabled={!installedSnap || busy}
                >
                  Public (mainnet)
                </ActionButton>
              </>
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
                onClick={async () => call('fund')}
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
                onClick={async () => call('getBalances')}
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
                  call('signMessage', {
                    message: 'Hello from the Stellar Soroban Snap!',
                  })
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
