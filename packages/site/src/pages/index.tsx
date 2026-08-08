import { useState } from 'react';
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
  const [result, setResult] = useState<string | null>(null);

  const isMetaMaskReady = isLocalSnap(defaultSnapOrigin)
    ? isFlask
    : snapsDetected;

  const handleGetAddressClick = async () => {
    setResult(null);
    const response = await invokeSnap({
      method: 'stellar_getAddress',
      params: { index: 0 },
    });
    setResult(JSON.stringify(response, null, 2));
  };

  const handleSdkSmokeClick = async () => {
    setResult(null);
    const response = await invokeSnap({ method: 'stellar_sdkSmoke' });
    setResult(JSON.stringify(response, null, 2));
  };

  return (
    <Container>
      <Heading>
        <Span>Stellar Soroban</Span> Snap
      </Heading>
      <Subtitle>Phase 0 — feasibility verification</Subtitle>
      <CardContainer>
        {error && (
          <ErrorMessage>
            <b>An error happened:</b> {error.message}
          </ErrorMessage>
        )}
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
              description:
                'Get started by connecting to and installing the example snap.',
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
            title: 'Get Stellar address',
            description:
              "Derive the SEP-0005 account m/44'/148'/0' from your MetaMask recovery phrase.",
            button: (
              <ActionButton
                onClick={handleGetAddressClick}
                disabled={!installedSnap}
              >
                Get address
              </ActionButton>
            ),
          }}
          disabled={!installedSnap}
        />
        <Card
          content={{
            title: 'Run SDK smoke test',
            description:
              'Build, sign, and XDR round-trip a transaction inside the snap sandbox.',
            button: (
              <ActionButton
                onClick={handleSdkSmokeClick}
                disabled={!installedSnap}
              >
                Run smoke test
              </ActionButton>
            ),
          }}
          disabled={!installedSnap}
        />
        {result && (
          <Notice>
            <Result>{result}</Result>
          </Notice>
        )}
        <Notice>
          <p>
            Expected address for the published SEP-0005 test mnemonic
            (&ldquo;illness spike retreat&hellip;&rdquo;):{' '}
            <b>GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6</b>. Any
            other recovery phrase yields its own address &mdash; compare it with
            Freighter using the same phrase.
          </p>
        </Notice>
      </CardContainer>
    </Container>
  );
};

export default Index;
