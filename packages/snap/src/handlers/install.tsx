import { Bold, Box, Heading, Text } from '@metamask/snaps-sdk/jsx';

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
