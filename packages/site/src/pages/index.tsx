import styled from 'styled-components';

import { Columns, Page, Stack } from '../components/Layout';
import { Alert } from '../components/Status';
import {
  Balances,
  DevBench,
  History,
  Onboarding,
  Send,
  Trustlines,
  WalletBar,
} from '../features';
import { useMetaMaskContext, useWallet } from '../hooks';

const Hero = styled.header`
  margin-bottom: 3.2rem;
  max-width: 72ch;
`;

const Title = styled.h1`
  margin: 0 0 1.2rem;
  font-weight: 700;
`;

const Accent = styled.span`
  color: ${({ theme }) => theme.colors.primary?.default};
`;

const Lead = styled.p`
  margin: 0;
  font-size: ${({ theme }) => theme.fontSizes.large};
  color: ${({ theme }) => theme.colors.text?.muted};
  ${({ theme }) => theme.mediaQueries.small} {
    font-size: ${({ theme }) => theme.fontSizes.text};
  }
`;

const Index = () => {
  const { error, setError } = useMetaMaskContext();
  const { ready } = useWallet();

  return (
    <Page>
      <Hero>
        <Title>
          Stellar on <Accent>MetaMask</Accent>
        </Title>
        <Lead>
          A working wallet for the Stellar Soroban snap: hold assets, send
          payments, manage trustlines, and read your account history. Every
          signature is reviewed inside MetaMask, decoded from the transaction
          itself.
        </Lead>
      </Hero>

      <Stack>
        {error ? (
          <Alert
            tone="error"
            title="Something went wrong."
            onDismiss={() => setError(null)}
          >
            {error.message}
          </Alert>
        ) : null}

        <Onboarding />
        <WalletBar />
        {ready ? (
          <>
            <Balances />
            <Columns>
              <Send />
              <Trustlines />
            </Columns>
            <History />
            <DevBench />
          </>
        ) : null}
      </Stack>
    </Page>
  );
};

export default Index;
