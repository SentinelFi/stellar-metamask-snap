import styled, { useTheme } from 'styled-components';

import { MetaMask } from './MetaMask';
import { PoweredBy } from './PoweredBy';
import { ReactComponent as MetaMaskFox } from '../assets/metamask_fox.svg';

const FooterWrapper = styled.footer`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1.2rem;
  padding-top: 2.4rem;
  padding-bottom: 2.4rem;
  border-top: 1px solid ${(props) => props.theme.colors.border?.default};
`;

const PoweredByButton = styled.a`
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: center;
  padding: 1.2rem;
  border-radius: ${({ theme }) => theme.radii.button};
  box-shadow: ${({ theme }) => theme.shadows.button};
  background-color: ${({ theme }) => theme.colors.background?.alternative};
`;

const PoweredByContainer = styled.div`
  display: flex;
  flex-direction: column;
  margin-left: 1rem;
`;

const LegalNotice = styled.p`
  margin: 0;
  font-size: ${({ theme }) => theme.fontSizes.small};
  color: ${({ theme }) => theme.colors.text?.muted};
  text-align: center;

  & a {
    color: ${({ theme }) => theme.colors.primary?.default};
    text-decoration: none;

    &:hover {
      text-decoration: underline;
    }
  }
`;

export const Footer = () => {
  const theme = useTheme();

  return (
    <FooterWrapper>
      <PoweredByButton
        href="https://docs.metamask.io/"
        target="_blank"
        rel="noopener noreferrer"
      >
        <MetaMaskFox />
        <PoweredByContainer>
          <PoweredBy color={theme.colors.text?.muted} />
          <MetaMask color={theme.colors.text?.default} />
        </PoweredByContainer>
      </PoweredByButton>
      <LegalNotice>
        © 2026 Stellar Soroban Snap — licensed under{' '}
        <a
          href="https://github.com/jeffnuclear/stelllar-metamask-snap/blob/main/LICENSE"
          target="_blank"
          rel="noopener noreferrer"
        >
          Apache 2.0
        </a>{' '}
        —{' '}
        <a
          href="https://github.com/jeffnuclear/stelllar-metamask-snap"
          target="_blank"
          rel="noopener noreferrer"
        >
          GitHub
        </a>
      </LegalNotice>
    </FooterWrapper>
  );
};
