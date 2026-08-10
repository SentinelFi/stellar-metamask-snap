import type { SnapComponent } from '@metamask/snaps-sdk/jsx';
import {
  Banner,
  Bold,
  Box,
  Copyable,
  Heading,
  Row,
  Section,
  Text,
} from '@metamask/snaps-sdk/jsx';

import type { NetworkName } from '../state/networks';

export type ConnectDialogProps = {
  origin: string;
  address: string;
  network: NetworkName;
};

/**
 * Connection request: the origin asks to see the wallet's Stellar address.
 *
 * @param props - Origin, address, and active network.
 * @param props.origin - The requesting dapp origin.
 * @param props.address - The wallet's Stellar address.
 * @param props.network - The active network name.
 * @returns The dialog content.
 */
export const ConnectDialog: SnapComponent<ConnectDialogProps> = ({
  origin,
  address,
  network,
}) => (
  <Box>
    <Heading>Connect to Stellar</Heading>
    <Text>
      <Bold>{origin}</Bold> wants to view your Stellar address and request
      signatures from this wallet.
    </Text>
    <Section>
      <Row label="Network">
        <Text>{network}</Text>
      </Row>
      <Text>Address</Text>
      <Copyable value={address} />
    </Section>
    <Text>
      The site cannot move funds without your approval — every transaction
      requires a separate confirmation.
    </Text>
  </Box>
);

export type NetworkDialogProps = {
  origin: string;
  from: NetworkName;
  to: NetworkName;
};

/**
 * Network switch confirmation.
 *
 * @param props - Origin plus the current and requested networks.
 * @param props.origin - The requesting dapp origin.
 * @param props.from - The current network.
 * @param props.to - The requested network.
 * @returns The dialog content.
 */
export const NetworkDialog: SnapComponent<NetworkDialogProps> = ({
  origin,
  from,
  to,
}) => (
  <Box>
    <Heading>Switch network</Heading>
    <Text>
      <Bold>{origin}</Bold> wants to switch the active Stellar network.
    </Text>
    <Section>
      <Row label="From">
        <Text>{from}</Text>
      </Row>
      <Row label="To" variant={to === 'PUBLIC' ? 'warning' : 'default'}>
        <Text>{to}</Text>
      </Row>
    </Section>
    {to === 'PUBLIC' ? (
      <Banner title="Mainnet" severity="warning">
        <Text>
          PUBLIC is the live Stellar network. Transactions signed there move
          real funds.
        </Text>
      </Banner>
    ) : null}
  </Box>
);

export type SignMessageDialogProps = {
  origin: string;
  address: string;
  message: string;
};

/**
 * SEP-53 message signing confirmation.
 *
 * @param props - Origin, signing address, and the message.
 * @param props.origin - The requesting dapp origin.
 * @param props.address - The wallet's Stellar address.
 * @param props.message - The message to sign.
 * @returns The dialog content.
 */
export const SignMessageDialog: SnapComponent<SignMessageDialogProps> = ({
  origin,
  address,
  message,
}) => (
  <Box>
    <Heading>Sign message</Heading>
    <Text>
      <Bold>{origin}</Bold> asks you to sign a message (SEP-53). Signing proves
      you control this account. It does not move funds and cannot be submitted
      as a transaction.
    </Text>
    <Section>
      <Text>Message</Text>
      <Copyable value={message} />
      <Text>Signing account</Text>
      <Copyable value={address} />
    </Section>
  </Box>
);
