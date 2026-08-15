import { Bold, Box, Heading, Text } from '@metamask/snaps-sdk/jsx';

import { CURRENT_DISCLOSURE_VERSION, getState } from '../state';

/**
 * `onUpdate` — shown once after the snap updates.
 *
 * The snap already refuses capabilities a grant predates: `getAccounts` fails
 * for an origin whose grant carries an older disclosure version, telling it to
 * call `requestAccess` again. That protects the user, but only the *site* is
 * told why, and the message surfaces as a dapp error the user may never see.
 * This hook tells the user directly, so a site that suddenly asks to reconnect
 * after an update is expected rather than suspicious, which is exactly the
 * situation a phishing site would otherwise be able to imitate.
 *
 * Silent when nothing needs re-consent: an update notice that always fires is
 * one users learn to dismiss unread.
 *
 * @returns Resolves when the user dismisses the dialog, or immediately when
 * there is nothing to report.
 */
export async function updateNotice(): Promise<void> {
  const { origins } = await getState();
  const stale = Object.values(origins).filter(
    (grant) => grant.disclosureVersion !== CURRENT_DISCLOSURE_VERSION,
  ).length;
  if (stale === 0) {
    return;
  }

  await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'alert',
      content: (
        <Box>
          <Heading>Stellar Soroban Snap updated</Heading>
          <Text>
            {`This update describes what a connected site is allowed to do more fully than the version ${stale === 1 ? 'one of your connected sites' : `${stale} of your connected sites`} agreed to.`}
          </Text>
          <Text>
            Those sites keep everything they already had, but the newly
            described capability stays <Bold>refused</Bold> until you approve
            the connection again. A site may therefore ask you to reconnect.
          </Text>
          <Text>
            You can review and remove connected sites at any time via MetaMask
            menu → Snaps → Stellar Soroban.
          </Text>
        </Box>
      ),
    },
  });
}

/**
 * `onInstall` — one-time welcome dialog after installation.
 *
 * @returns Resolves when the user dismisses the dialog.
 */
export async function installWelcome(): Promise<void> {
  await snap.request({
    method: 'snap_dialog',
    params: {
      type: 'alert',
      content: (
        <Box>
          <Heading>Stellar Soroban Snap installed</Heading>
          <Text>
            MetaMask can now derive your <Bold>Stellar</Bold> account and sign
            Stellar and Soroban transactions.
          </Text>
          <Text>
            Your account starts on <Bold>TESTNET</Bold>. Any connected dapp must
            ask for access, and every signature requires your confirmation here
            in MetaMask.
          </Text>
          <Text>
            View your address and balances anytime via MetaMask menu → Snaps →
            Stellar Soroban.
          </Text>
        </Box>
      ),
    },
  });
}
