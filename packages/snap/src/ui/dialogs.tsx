import type {
  GenericSnapElement,
  SnapComponent,
} from '@metamask/snaps-sdk/jsx';
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

import {
  displayOrigin,
  escapeHiddenCharacters,
  isOriginDisplayLossy,
  originLooksConfusable,
} from './format';
import type { NetworkName } from '../state/networks';

/**
 * Origin cautions shown on every consent dialog: a warning when the origin
 * contains internationalized (punycode) or non-ASCII characters that could
 * visually imitate another site's address, and the complete origin whenever
 * the inline display had to shorten or sanitize it — middle truncation keeps
 * only a prefix and suffix, so two long origins can otherwise display
 * identically.
 *
 * @param origin - The requesting dapp origin.
 * @returns The caution elements, or null when the inline display is exact
 * and unsuspicious.
 */
export function originCautionBanner(origin: string): GenericSnapElement | null {
  const confusable = originLooksConfusable(origin);
  const lossy = isOriginDisplayLossy(origin);
  if (!confusable && !lossy) {
    return null;
  }
  return (
    <Box>
      {confusable ? (
        <Banner title="Check the site address" severity="warning">
          <Text>
            This site's address contains internationalized or unusual characters
            that can imitate another site. Verify the address before approving.
          </Text>
        </Banner>
      ) : null}
      {lossy ? (
        <Box>
          <Banner title="Site address shortened" severity="warning">
            <Text>
              This site's address is too long to show in full above, and two
              different long addresses can look identical when shortened. Verify
              the complete address below before approving.
            </Text>
          </Banner>
          <Copyable value={escapeHiddenCharacters(origin)} />
        </Box>
      ) : null}
    </Box>
  );
}

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
      Approving also connects <Bold>{displayOrigin(origin)}</Bold> to this
      wallet. A connected site can read your address and balances, list every
      account you have added in this wallet (which links them to each other),
      suggest tokens to track, and request test-network funding of this wallet
      without further prompts, until you disconnect it on the snap home page.
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
      <Bold>{displayOrigin(origin)}</Bold> wants to view your Stellar address
      and request signatures from this wallet.
    </Text>
    {originCautionBanner(origin)}
    <Section>
      <Row label="Network">
        <Text>{network}</Text>
      </Row>
      <Text>Address</Text>
      <Copyable value={address} />
    </Section>
    <Text>
      A connected site can read your address and balances, list every account
      you have added in this wallet (which links them to each other), suggest
      tokens to track, and request test-network funding without further prompts,
      until you disconnect it on the snap home page.
    </Text>
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
      <Bold>{displayOrigin(origin)}</Bold> wants to switch the active Stellar
      network. This setting is wallet-global: it changes the network for every
      connected site, not just this one.
    </Text>
    {originCautionBanner(origin)}
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
  /** The SEP-0005 index of the authorizing account. */
  accountIndex: number;
  /** Human-readable invocation tree, root first. */
  invocations: string[];
  nonce: string;
  signatureExpirationLedger: number;
  /** Ledgers until expiry, verified against the current ledger. */
  ledgersRemaining: number;
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
 * @param props.accountIndex - The authorizing account's SEP-0005 index.
 * @param props.invocations - Rendered invocation tree, root first.
 * @param props.nonce - The entry's replay-protection nonce.
 * @param props.signatureExpirationLedger - Ledger after which the signature
 * expires.
 * @param props.ledgersRemaining - Ledgers until expiry, verified against the
 * current ledger.
 * @returns The dialog content.
 */
export const SignAuthEntryDialog: SnapComponent<SignAuthEntryDialogProps> = ({
  origin,
  network,
  address,
  accountIndex,
  invocations,
  nonce,
  signatureExpirationLedger,
  ledgersRemaining,
}) => (
  <Box>
    <Heading>Authorize contract call</Heading>
    <Text>
      <Bold>{displayOrigin(origin)}</Bold> asks you to authorize the following
      Soroban contract call(s) on behalf of your account (this signs the
      authorization only — a transaction will carry it later).
    </Text>
    {originCautionBanner(origin)}
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
          {`${approxDuration(ledgersRemaining)} (ledger ${signatureExpirationLedger})`}
        </Text>
      </Row>
      <Row label="Nonce">
        <Text>{nonce}</Text>
      </Row>
      <Row label="Authorizing account">
        <Text>{`Account ${accountIndex}`}</Text>
      </Row>
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
  /**
   * The classic asset this contract provably is, when it is that asset's
   * Stellar Asset Contract (`XLM (native)` or the full `CODE:ISSUER`);
   * null for every other contract. Verified by derivation, not by what the
   * contract says about itself.
   */
  stellarAsset?: string | null;
};

/**
 * Confirmation for tracking a Soroban token (SAC/SEP-41) for balance
 * display. Metadata shown is read from the contract, not supplied by the
 * dapp; but the contract is no more trustworthy a source for its own name
 * than the dapp is, so the dialog says in words that the symbol is the
 * contract's own claim, and names the one identity the snap can verify: the
 * full contract address, plus the classic asset when the contract is that
 * asset's Stellar Asset Contract.
 *
 * @param props - The dialog props.
 * @param props.origin - The requesting dapp origin.
 * @param props.network - The active network name.
 * @param props.contractId - The token contract address.
 * @param props.symbol - The token symbol read from the contract.
 * @param props.decimals - The token decimals read from the contract.
 * @param props.stellarAsset - The verified classic asset identity, if any.
 * @returns The dialog content.
 */
export const AddTokenDialog: SnapComponent<AddTokenDialogProps> = ({
  origin,
  network,
  contractId,
  symbol,
  decimals,
  stellarAsset = null,
}) => (
  <Box>
    <Heading>Add token</Heading>
    <Text>
      <Bold>{displayOrigin(origin)}</Bold> wants to track a Soroban token so its
      balance shows in this wallet on <Bold>{network}</Bold>. This does not
      grant any spending permission.
    </Text>
    {originCautionBanner(origin)}
    {symbol.toUpperCase() === 'XLM' && stellarAsset !== 'XLM (native)' ? (
      <Banner title="Not the native asset" severity="warning">
        <Text>
          This contract calls itself XLM, but it is not the native lumen asset.
          Its balance rows always show the contract address next to the symbol
          so the two stay distinguishable.
        </Text>
      </Banner>
    ) : null}
    <Section>
      <Row label="Symbol (self-reported)">
        <Text>{symbol}</Text>
      </Row>
      <Row label="Decimals">
        <Text>{String(decimals)}</Text>
      </Row>
      {stellarAsset === null ? (
        <Text>
          The symbol is what the contract says about itself and is not verified:
          any contract can call itself anything. The contract address below is
          its only identity. Check it against a source you trust before
          approving.
        </Text>
      ) : (
        <Box>
          <Text>Stellar asset (verified)</Text>
          <Copyable value={stellarAsset} />
          <Text>
            This contract is the Stellar Asset Contract of the classic asset
            above, which the wallet confirmed by derivation.
          </Text>
        </Box>
      )}
      <Text>Contract</Text>
      <Copyable value={contractId} />
    </Section>
  </Box>
);

export type SignMessageDialogProps = {
  origin: string;
  /** The active network, stated for parity with the other signing dialogs. */
  network: NetworkName;
  address: string;
  /** The SEP-0005 index of the signing account. */
  accountIndex: number;
  message: string;
  /** The message contains control/bidi characters that can spoof display. */
  hasHiddenCharacters: boolean;
};

/**
 * SEP-53 message signing confirmation.
 *
 * The network banner needs a word, because a SEP-53 signature is the one
 * signature this snap produces that is *not* bound to a network: the payload
 * is `SHA-256("Stellar Signed Message:\n" + message)` and carries no network
 * ID. That is exactly why the banner belongs here rather than being omitted as
 * inapplicable. The signature proves control of an account, and a
 * mainnet-facing verifier will accept that proof whatever network the wallet
 * was set to when it was produced. Since the other three signing dialogs all
 * state the network, its absence here read as "network is not a factor", which
 * is true of the bytes and misleading about the consequences.
 *
 * @param props - Origin, network, signing address, and the message.
 * @param props.origin - The requesting dapp origin.
 * @param props.network - The active network name.
 * @param props.address - The signing account's Stellar address.
 * @param props.accountIndex - The signing account's SEP-0005 index.
 * @param props.message - The message to sign.
 * @param props.hasHiddenCharacters - Whether the message contains hidden
 * characters (the exact bytes are signed either way; the user is warned).
 * @returns The dialog content.
 */
export const SignMessageDialog: SnapComponent<SignMessageDialogProps> = ({
  origin,
  network,
  address,
  accountIndex,
  message,
  hasHiddenCharacters,
}) => (
  <Box>
    <Heading>Sign message</Heading>
    <Text>
      <Bold>{displayOrigin(origin)}</Bold> asks you to sign a message (SEP-53).
      Signing proves you control this account. It does not move funds and cannot
      be submitted as a transaction.
    </Text>
    {originCautionBanner(origin)}
    {network === 'PUBLIC' ? (
      <Banner title="Mainnet" severity="warning">
        <Text>
          This wallet is on the live Stellar network. A signed message is not
          tied to any network, so this signature proves control of a mainnet
          account.
        </Text>
      </Banner>
    ) : (
      <Banner title={network} severity="info">
        <Text>
          {`This wallet is on ${network}. A signed message is not tied to any network, so this signature proves control of the account shown below wherever it is presented.`}
        </Text>
      </Banner>
    )}
    {hasHiddenCharacters ? (
      <Banner title="Hidden characters" severity="warning">
        <Text>
          This message contains invisible or direction-altering characters —
          what you read here may not be what the site intends. Compare the exact
          escaped form below. Only sign if you trust the requesting site.
        </Text>
      </Banner>
    ) : null}
    <Section>
      <Text>Message</Text>
      <Copyable value={message} />
      {hasHiddenCharacters ? (
        // The block above shows (and copies) the raw message, in which
        // hidden characters stay hidden; this one makes every such code
        // point visible so the user can see exactly what they sign.
        <Box>
          <Text>Message (exact, special characters escaped)</Text>
          <Copyable value={escapeHiddenCharacters(message)} />
        </Box>
      ) : null}
      <Row label="Signing account">
        <Text>{`Account ${accountIndex}`}</Text>
      </Row>
      <Copyable value={address} />
    </Section>
    <ConnectionGrantNotice origin={origin} />
  </Box>
);

export type AddAccountDialogProps = {
  index: number;
  address: string;
};

/**
 * Confirmation for revealing the next SEP-0005 account (home-page flow).
 * Revealing an account makes it selectable for signing and visible to
 * connected sites via account enumeration.
 *
 * @param props - The dialog props.
 * @param props.index - The SEP-0005 index being revealed.
 * @param props.address - The address derived for that index.
 * @returns The dialog content.
 */
export const AddAccountDialog: SnapComponent<AddAccountDialogProps> = ({
  index,
  address,
}) => (
  <Box>
    <Heading>Add account</Heading>
    <Text>
      {`This adds account ${index} (SEP-0005 path m/44'/148'/${index}') to this wallet. The same account appears in any SEP-0005 wallet restored from this secret recovery phrase.`}
    </Text>
    <Section>
      <Row label="Account">
        <Text>{`Account ${index}`}</Text>
      </Row>
      <Text>Address</Text>
      <Copyable value={address} />
    </Section>
    <Text>
      Connected sites that enumerate your accounts will see this address. If you
      keep separate accounts to avoid linking activity, be aware they are
      disclosed together.
    </Text>
  </Box>
);

export type FindAccountDialogProps = {
  index: number;
  address: string;
  /** How many accounts this reveals, including the target. */
  count: number;
  /** The lowest index being revealed. */
  from: number;
};

/**
 * Confirmation for revealing a run of SEP-0005 accounts up to a located one
 * (home-page account lookup).
 *
 * The account set is kept gap-free so it matches how other SEP-0005 wallets
 * enumerate accounts, which means reaching account N also reveals everything
 * below it. That is stated plainly here rather than left as a surprise,
 * because every revealed address becomes visible to connected sites.
 *
 * @param props - The dialog props.
 * @param props.index - The located SEP-0005 index.
 * @param props.address - The address derived for that index.
 * @param props.count - How many accounts are revealed in total.
 * @param props.from - The lowest index being revealed.
 * @returns The dialog content.
 */
export const FindAccountDialog: SnapComponent<FindAccountDialogProps> = ({
  index,
  address,
  count,
  from,
}) => (
  <Box>
    <Heading>Add account</Heading>
    <Text>
      {`This adds account ${index} (SEP-0005 path m/44'/148'/${index}') to this wallet. The same account appears in any SEP-0005 wallet restored from this secret recovery phrase.`}
    </Text>
    <Section>
      <Row label="Account">
        <Text>{`Account ${index}`}</Text>
      </Row>
      <Text>Address</Text>
      <Copyable value={address} />
    </Section>
    {count > 1 ? (
      <Text>
        {`Accounts are kept gap-free, so this also adds accounts ${from} to ${
          index - 1
        }: ${count} accounts in total.`}
      </Text>
    ) : null}
    <Text>
      Connected sites that enumerate your accounts will see these addresses. If
      you keep separate accounts to avoid linking activity, be aware they are
      disclosed together.
    </Text>
  </Box>
);

export type SwitchAccountDialogProps = {
  origin: string;
  fromIndex: number;
  toIndex: number;
  toAddress: string;
};

/**
 * Active-account switch confirmation (RPC `setActiveAccount`). Wallet-global,
 * mirroring the network switch.
 *
 * @param props - The dialog props.
 * @param props.origin - The requesting dapp origin.
 * @param props.fromIndex - The currently active account index.
 * @param props.toIndex - The requested account index.
 * @param props.toAddress - The requested account's address.
 * @returns The dialog content.
 */
export const SwitchAccountDialog: SnapComponent<SwitchAccountDialogProps> = ({
  origin,
  fromIndex,
  toIndex,
  toAddress,
}) => (
  <Box>
    <Heading>Switch account</Heading>
    <Text>
      <Bold>{displayOrigin(origin)}</Bold> wants to switch the active account.
      This setting is wallet-global: every connected site sees the new active
      account, not just this one.
    </Text>
    {originCautionBanner(origin)}
    <Section>
      <Row label="From">
        <Text>{`Account ${fromIndex}`}</Text>
      </Row>
      <Row label="To">
        <Text>{`Account ${toIndex}`}</Text>
      </Row>
      <Text>New active address</Text>
      <Copyable value={toAddress} />
    </Section>
  </Box>
);
