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

export type ConnectionGrantNoticeProps = {
  origin: string;
};

/**
 * Discloses the durable origin grant that an approved signature creates:
 * the user must know a one-time signing decision also connects the
 * site and what that connection allows, and how to undo it.
 *
 * @param props - The notice props.
 * @param props.origin - The requesting dapp origin.
 * @returns The notice content.
 */
export const ConnectionGrantNotice: SnapComponent<
  ConnectionGrantNoticeProps
> = ({ origin }) => (
  <Section>
    <Text>
      Approving also connects <Bold>{origin}</Bold> to this wallet. A connected
      site can read your address and balances, suggest tokens to track, and
      request test-network funding of this wallet without further prompts, until
      you disconnect it on the snap home page.
    </Text>
  </Section>
);

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
      <Bold>{origin}</Bold> wants to switch the active Stellar network. This
      setting is wallet-global: it changes the network for every connected site,
      not just this one.
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

export type SignAuthEntryDialogProps = {
  origin: string;
  network: NetworkName;
  address: string;
  /** Human-readable invocation tree, root first. */
  invocations: string[];
  nonce: string;
  signatureExpirationLedger: number;
  /** Ledgers until expiry, or null when the current ledger is unknown. */
  ledgersRemaining: number | null;
};

/**
 * Renders a ledger delta as an approximate human duration (~5s per ledger).
 *
 * @param ledgers - Ledgers remaining until expiry.
 * @returns A short duration string.
 */
function approxDuration(ledgers: number): string {
  const seconds = ledgers * 5;
  if (seconds < 3600) {
    return `~${Math.max(1, Math.round(seconds / 60))} min`;
  }
  if (seconds < 86400) {
    return `~${Math.round(seconds / 3600)} h`;
  }
  return `~${Math.round(seconds / 86400)} d`;
}

/**
 * Soroban authorization-entry signing confirmation. The signature authorizes
 * the displayed contract calls on behalf of the account, independent of the
 * transaction envelope that will carry them.
 *
 * @param props - The dialog props.
 * @param props.origin - The requesting dapp origin.
 * @param props.network - The active network name.
 * @param props.address - The authorizing account.
 * @param props.invocations - Rendered invocation tree, root first.
 * @param props.nonce - The entry's replay-protection nonce.
 * @param props.signatureExpirationLedger - Ledger after which the signature
 * expires.
 * @param props.ledgersRemaining - Ledgers until expiry, or null when unknown.
 * @returns The dialog content.
 */
export const SignAuthEntryDialog: SnapComponent<SignAuthEntryDialogProps> = ({
  origin,
  network,
  address,
  invocations,
  nonce,
  signatureExpirationLedger,
  ledgersRemaining,
}) => (
  <Box>
    <Heading>Authorize contract call</Heading>
    <Text>
      <Bold>{origin}</Bold> asks you to authorize the following Soroban contract
      call(s) on behalf of your account (this signs the authorization only — a
      transaction will carry it later).
    </Text>
    {network === 'PUBLIC' ? (
      <Banner title="Mainnet" severity="warning">
        <Text>This authorization is for the live Stellar network.</Text>
      </Banner>
    ) : (
      <Banner title={network} severity="info">
        <Text>{`This authorization is for the ${network} network.`}</Text>
      </Banner>
    )}
    <Section>
      <Text>Authorized calls</Text>
      <Copyable value={invocations.join('\n')} />
      <Row label="Expires in">
        <Text>
          {ledgersRemaining === null
            ? `at ledger ${signatureExpirationLedger} (lifetime unverified — RPC unreachable)`
            : `${approxDuration(ledgersRemaining)} (ledger ${signatureExpirationLedger})`}
        </Text>
      </Row>
      <Row label="Nonce">
        <Text>{nonce}</Text>
      </Row>
      <Text>Authorizing account</Text>
      <Copyable value={address} />
    </Section>
    <ConnectionGrantNotice origin={origin} />
  </Box>
);

export type AddTokenDialogProps = {
  origin: string;
  network: NetworkName;
  contractId: string;
  symbol: string;
  decimals: number;
};

/**
 * Confirmation for tracking a Soroban token (SAC/SEP-41) for balance
 * display. Metadata shown is read from the contract, not supplied by the
 * dapp.
 *
 * @param props - The dialog props.
 * @param props.origin - The requesting dapp origin.
 * @param props.network - The active network name.
 * @param props.contractId - The token contract address.
 * @param props.symbol - The token symbol read from the contract.
 * @param props.decimals - The token decimals read from the contract.
 * @returns The dialog content.
 */
export const AddTokenDialog: SnapComponent<AddTokenDialogProps> = ({
  origin,
  network,
  contractId,
  symbol,
  decimals,
}) => (
  <Box>
    <Heading>Add token</Heading>
    <Text>
      <Bold>{origin}</Bold> wants to track a Soroban token so its balance shows
      in this wallet on <Bold>{network}</Bold>. This does not grant any spending
      permission.
    </Text>
    <Section>
      <Row label="Symbol">
        <Text>{symbol}</Text>
      </Row>
      <Row label="Decimals">
        <Text>{String(decimals)}</Text>
      </Row>
      <Text>Contract</Text>
      <Copyable value={contractId} />
    </Section>
  </Box>
);

export type SignMessageDialogProps = {
  origin: string;
  address: string;
  message: string;
  /** The message contains control/bidi characters that can spoof display. */
  hasHiddenCharacters: boolean;
};

/**
 * SEP-53 message signing confirmation.
 *
 * @param props - Origin, signing address, and the message.
 * @param props.origin - The requesting dapp origin.
 * @param props.address - The wallet's Stellar address.
 * @param props.message - The message to sign.
 * @param props.hasHiddenCharacters - Whether the message contains hidden
 * characters (the exact bytes are signed either way; the user is warned).
 * @returns The dialog content.
 */
export const SignMessageDialog: SnapComponent<SignMessageDialogProps> = ({
  origin,
  address,
  message,
  hasHiddenCharacters,
}) => (
  <Box>
    <Heading>Sign message</Heading>
    <Text>
      <Bold>{origin}</Bold> asks you to sign a message (SEP-53). Signing proves
      you control this account. It does not move funds and cannot be submitted
      as a transaction.
    </Text>
    {hasHiddenCharacters ? (
      <Banner title="Hidden characters" severity="warning">
        <Text>
          This message contains invisible or direction-altering characters —
          what you read here may not be what the site intends. Only sign if you
          trust the requesting site.
        </Text>
      </Banner>
    ) : null}
    <Section>
      <Text>Message</Text>
      <Copyable value={message} />
      <Text>Signing account</Text>
      <Copyable value={address} />
    </Section>
    <ConnectionGrantNotice origin={origin} />
  </Box>
);
