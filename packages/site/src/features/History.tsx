import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import { Button } from '../components/Form';
import { Panel } from '../components/Layout';
import { AddressChip, Badge, ExternalLink } from '../components/Status';
import { DataTable, Td, Tr } from '../components/Table';
import { useWallet } from '../hooks';
import type { Direction, HistoryEntry } from '../utils';
import {
  explorerTxUrl,
  fetchHistory,
  formatAmount,
  formatTimestamp,
  handle,
  HISTORY_LIMIT,
} from '../utils';

// Incoming value is the one thing worth colouring: an outgoing row reads as
// ordinary text, so the eye is drawn to money arriving rather than to every
// row equally.
const DIRECTION_COLOR = {
  in: 'success',
  out: 'text',
  neutral: 'muted',
} as const;

const Signed = styled.span<{ direction: Direction }>`
  font-family: ${({ theme }) => theme.fonts.code};
  color: ${({ theme, direction }) =>
    direction === 'in'
      ? theme.colors.success?.default
      : theme.colors.text?.[DIRECTION_COLOR[direction]]};
`;

/**
 * The transaction column: a link when the network has an explorer, the bare
 * hash when it does not, and an em dash when Horizon reported none.
 *
 * @param props - Cell props.
 * @param props.hash - The transaction hash, when the record carried one.
 * @param props.explorer - The explorer URL, when the network has one.
 * @returns The cell content.
 */
const TransactionCell = ({
  hash,
  explorer,
}: {
  hash: string | null;
  explorer: string | null;
}) => {
  if (!hash) {
    return <>—</>;
  }
  if (explorer) {
    return (
      <ExternalLink href={explorer}>{`${hash.slice(0, 8)}…`}</ExternalLink>
    );
  }
  return <AddressChip value={hash} keep={5} />;
};

/** The sign shown in front of an amount, by direction. */
const DIRECTION_SIGN: Record<Direction, string> = {
  in: '+',
  out: '-',
  neutral: '',
};

/**
 * The line shown in place of the table.
 *
 * @param state - What the panel knows.
 * @param state.connected - Whether a grant exists.
 * @param state.loaded - Whether a fetch has completed.
 * @returns The empty-state sentence.
 */
function emptyMessage({
  connected,
  loaded,
}: {
  connected: boolean;
  loaded: boolean;
}): string {
  if (connected && loaded) {
    return 'No operations yet for this account.';
  }
  return connected
    ? 'Loading activity…'
    : 'Connect the wallet to read its history.';
}

const COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'what', label: 'Operation' },
  { key: 'amount', label: 'Amount', align: 'right' as const },
  { key: 'party', label: 'Counterparty' },
  { key: 'tx', label: 'Transaction' },
];

/**
 * Recent account activity, read directly from Horizon.
 *
 * This is the one panel that talks to the network without going through the
 * wallet, and it uses the Horizon URL the wallet reports rather than one of
 * its own, so the history a user reads is always from the network their
 * wallet is actually on.
 *
 * @returns The history panel.
 */
export const History = () => {
  const { ready, connected, address, network } = useWallet();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const horizonUrl = network?.networkUrl ?? null;

  const load = useCallback(async () => {
    if (!horizonUrl || !address) {
      setEntries([]);
      setLoaded(false);
      return;
    }
    setLoading(true);
    try {
      setEntries(await fetchHistory(horizonUrl, address));
      setLoaded(true);
    } finally {
      setLoading(false);
    }
  }, [horizonUrl, address]);

  // Reloads when the account or the network changes, and after any action
  // that refreshed wallet state (the wallet's balances object is replaced on
  // every refresh, which is what makes a submitted payment show up here).
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  if (!ready) {
    return null;
  }

  return (
    <Panel
      id="history"
      title="Activity"
      description={`The account's last ${HISTORY_LIMIT} operations, including failed ones, read from Horizon.`}
      actions={
        <Button
          small
          disabled={!connected || loading}
          onClick={handle(async () => load())}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      }
    >
      <DataTable
        columns={COLUMNS}
        hasRows={entries.length > 0}
        empty={emptyMessage({ connected, loaded })}
      >
        {entries.map((entry) => {
          const explorer =
            network && entry.hash
              ? explorerTxUrl(network.network, entry.hash)
              : null;
          return (
            <Tr key={entry.id}>
              <Td>{formatTimestamp(entry.createdAt)}</Td>
              <Td>
                {entry.label}
                {entry.successful ? null : (
                  <>
                    {' '}
                    <Badge tone="error">Failed</Badge>
                  </>
                )}
              </Td>
              <Td align="right">
                {entry.amount ? (
                  <Signed direction={entry.direction}>
                    {`${DIRECTION_SIGN[entry.direction]}${formatAmount(entry.amount)} ${entry.asset ?? ''}`}
                  </Signed>
                ) : (
                  <Signed direction="neutral">—</Signed>
                )}
              </Td>
              <Td>
                {entry.counterparty ? (
                  <AddressChip value={entry.counterparty} keep={5} />
                ) : (
                  '—'
                )}
              </Td>
              <Td>
                <TransactionCell hash={entry.hash} explorer={explorer} />
              </Td>
            </Tr>
          );
        })}
      </DataTable>
    </Panel>
  );
};
