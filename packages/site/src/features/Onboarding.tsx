import styled from 'styled-components';

import { Button, LinkButton } from '../components/Form';
import { Panel, Stack } from '../components/Layout';
import { Alert } from '../components/Status';
import { defaultSnapOrigin, defaultSnapVersion } from '../config';
import { useMetaMask, useRequestSnap, useWallet } from '../hooks';
import { handle, isLocalSnap, shouldDisplayReconnectButton } from '../utils';

const Lead = styled.p`
  margin: 0;
  color: ${({ theme }) => theme.colors.text?.alternative};
  max-width: 68ch;
`;

/**
 * Everything that has to happen before the wallet panels are usable:
 * installing MetaMask Flask when the snap is served locally, installing the
 * snap itself, and updating it when the installed version is not the one this
 * site was built against.
 *
 * The version gate is the reason this is a panel rather than a button. An
 * installed snap of the wrong version must not be treated as the audited
 * release, so every other panel stays hidden until it matches, and the user
 * needs to be told why.
 *
 * @returns The onboarding panel, or null once everything is ready.
 */
export const Onboarding = () => {
  const { isFlask, snapsDetected, installedSnap } = useMetaMask();
  const { ready, versionMismatch } = useWallet();
  const requestSnap = useRequestSnap();

  const metaMaskReady = isLocalSnap(defaultSnapOrigin)
    ? isFlask
    : snapsDetected;
  const showReconnect = shouldDisplayReconnectButton(installedSnap);

  if (ready && !showReconnect) {
    return null;
  }

  if (!metaMaskReady) {
    return (
      <Panel
        title="Install MetaMask Flask"
        description="This build installs the snap from a local development server, which only MetaMask Flask allows."
      >
        <LinkButton
          variant="primary"
          href="https://metamask.io/flask/"
          target="_blank"
          rel="noopener noreferrer"
        >
          Get MetaMask Flask
        </LinkButton>
      </Panel>
    );
  }

  if (versionMismatch && installedSnap) {
    return (
      <Panel title="Update the snap">
        <Stack gap="1.2rem">
          <Alert tone="warning" title="Version mismatch.">
            {`The installed snap is version ${installedSnap.version.slice(0, 32)}, but this site was built for version ${defaultSnapVersion ?? 'unknown'}. Every control stays disabled until they match, so the page can never drive a release it was not built against.`}
          </Alert>
          <Button variant="primary" onClick={handle(async () => requestSnap())}>
            {`Update to ${defaultSnapVersion ?? 'the expected version'}`}
          </Button>
        </Stack>
      </Panel>
    );
  }

  if (!installedSnap) {
    return (
      <Panel
        title="Connect the Stellar Soroban snap"
        description="The snap derives Stellar keys from your MetaMask Secret Recovery Phrase and decodes every transaction it is asked to sign."
      >
        <Stack gap="1.6rem">
          <Lead>
            Installing adds Stellar support to MetaMask. Nothing is signed
            without a dialog you approve, and this page never sees a private
            key.
          </Lead>
          <Button variant="primary" onClick={handle(async () => requestSnap())}>
            Install snap
          </Button>
        </Stack>
      </Panel>
    );
  }

  return (
    <Panel
      title="Local development snap"
      description="This site is pointed at a locally served snap, so it offers a reconnect control to pick up rebuilds."
    >
      <Button onClick={handle(async () => requestSnap())}>Reconnect</Button>
    </Panel>
  );
};
