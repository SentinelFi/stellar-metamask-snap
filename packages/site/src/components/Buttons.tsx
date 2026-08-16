import type { ComponentProps } from 'react';
import styled from 'styled-components';

import { Button as BaseButton, LinkButton as BaseLink } from './Form';
import { ReactComponent as FlaskFox } from '../assets/flask_fox.svg';
import { useMetaMask, useRequestSnap } from '../hooks';
import { isExpectedSnapVersion, shouldDisplayReconnectButton } from '../utils';

/*
 * These carry their own appearance rather than inheriting a blanket `button`
 * rule from the global style. The global rule now sets only typography and
 * cursor, so that a secondary or destructive control elsewhere on the page
 * can look different from the one that signs.
 */

const Link = styled(BaseLink)`
  max-width: 100%;
`;

const Button = styled(BaseButton)`
  ${({ theme }) => theme.mediaQueries.small} {
    width: 100%;
  }

  & svg {
    width: 2rem;
    height: 2rem;
  }
`;

const ButtonText = styled.span`
  white-space: nowrap;
`;

const ConnectedContainer = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.8rem;
  font-size: ${(props) => props.theme.fontSizes.tiny};
  font-weight: 600;
  border-radius: ${(props) => props.theme.radii.pill};
  border: 1px solid ${(props) => props.theme.colors.border?.default};
  background-color: ${(props) => props.theme.colors.background?.alternative};
  color: ${(props) => props.theme.colors.text?.default};
  padding: 0.6rem 1.2rem;
`;

const ConnectedIndicator = styled.div`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: ${({ theme }) => theme.colors.success?.default};
`;

export const InstallFlaskButton = () => (
  <Link
    href="https://metamask.io/flask/"
    target="_blank"
    rel="noopener noreferrer"
  >
    <FlaskFox />
    <ButtonText>Install MetaMask Flask</ButtonText>
  </Link>
);

export const ConnectButton = (props: ComponentProps<typeof Button>) => {
  return (
    <Button {...props}>
      <FlaskFox />
      <ButtonText>Connect</ButtonText>
    </Button>
  );
};

export const ReconnectButton = (props: ComponentProps<typeof Button>) => {
  return (
    <Button {...props}>
      <FlaskFox />
      <ButtonText>Reconnect</ButtonText>
    </Button>
  );
};

export const UpdateButton = (props: ComponentProps<typeof Button>) => {
  return (
    <Button {...props}>
      <FlaskFox />
      <ButtonText>Update required</ButtonText>
    </Button>
  );
};

export const ActionButton = (props: ComponentProps<typeof Button>) => {
  return <Button {...props} />;
};

export const HeaderButtons = () => {
  const requestSnap = useRequestSnap();
  const { isFlask, installedSnap } = useMetaMask();

  if (!isFlask && !installedSnap) {
    return <InstallFlaskButton />;
  }

  if (!installedSnap) {
    return <ConnectButton onClick={requestSnap} />;
  }

  if (shouldDisplayReconnectButton(installedSnap)) {
    return <ReconnectButton onClick={requestSnap} />;
  }

  // A wrong-version snap must not present as connected: the page disables
  // every control until the user updates, and the header has to tell the
  // same story, or the green indicator would vouch for a release this site
  // was not built (or audited) for. The button re-runs wallet_requestSnaps,
  // which pins the expected version and so performs the update.
  if (!isExpectedSnapVersion(installedSnap)) {
    return <UpdateButton onClick={requestSnap} />;
  }

  return (
    <ConnectedContainer>
      <ConnectedIndicator />
      <ButtonText>Connected</ButtonText>
    </ConnectedContainer>
  );
};
