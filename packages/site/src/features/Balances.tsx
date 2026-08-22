import type { FormEvent } from 'react';
import { useState } from 'react';
import styled from 'styled-components';

import { Button, Input } from '../components/Form';
import { Panel, Stack } from '../components/Layout';
import { Alert, AddressChip, Badge, Mono } from '../components/Status';
import { DataTable, Td, Tr } from '../components/Table';
import { useWallet } from '../hooks';
import { assetCode, assetIssuer, formatAmount, handle } from '../utils';

const AddTokenRow = styled.form`
  display: flex;
  flex-wrap: wrap;
  gap: 0.8rem;
  align-items: center;
  margin-top: 1.6rem;
  padding-top: 1.6rem;
  border-top: 1px solid ${({ theme }) => theme.colors.border?.default};

  & > input {
    flex: 1 1 32rem;
  }
`;

const COLUMNS = [
  { key: 'asset', label: 'Asset' },
  { key: 'kind', label: 'Kind' },
  { key: 'issuer', label: 'Issuer / contract' },
  { key: 'balance', label: 'Balance', align: 'right' as const },
];

const KIND_LABEL = {
  native: 'Native',
  classic: 'Classic',
  soroban: 'Soroban token',
  pool: 'Pool shares',
} as const;

/**
 * The balances table, plus the control that starts tracking a Soroban token
 * by contract id.
 *
 * Asset rows are keyed on the row's `type`, never on parsing its display
 * string: a classic asset and a tracked token are both `NAME:SOMETHING`, and
 * a token's symbol is chosen by whoever wrote its contract. The issuer or
 * contract is shown on every non-native row for the same reason, so a token
 * calling itself `USDC` stays distinguishable from the real one.
 *
 * @returns The balances panel.
 */
export const Balances = () => {
  const { ready, connected, busy, balances, run } = useWallet();
  const [contractId, setContractId] = useState('');

  if (!ready) {
    return null;
  }

  const rows = balances?.balances ?? [];

  /**
   * Starts tracking the entered contract. The wallet confirms the contract and
   * reads its symbol and decimals itself, so nothing here is trusted on the
   * page's say-so.
   *
   * @param event - The form submit event.
   */
  const trackToken = async (event: FormEvent) => {
    event.preventDefault();
    const value = contractId.trim();
    if (!value) {
      return;
    }
    const added = await run(async (client) => client.addToken(value));
    if (added) {
      setContractId('');
    }
  };

  return (
    <Panel
      id="balances"
      title="Balances"
      description="Classic balances come from Horizon; Soroban token rows are read from each tracked contract by simulation."
      actions={
        <Button
          small
          disabled={!connected || busy}
          onClick={handle(async () =>
            run(async (client) => client.getBalances()),
          )}
        >
          Refresh
        </Button>
      }
    >
      <Stack gap="1.2rem">
        {balances?.tokensUnavailable ? (
          <Alert tone="warning" title="Token rows are missing.">
            The wallet&apos;s token-read budget was exhausted, so tracked
            Soroban balances were skipped this time. Classic balances are
            complete. Retry shortly; do not read this as holding none of them.
          </Alert>
        ) : null}

        <DataTable
          columns={COLUMNS}
          hasRows={rows.length > 0}
          empty={
            connected
              ? 'No balances yet. Fund the account on a test network to get started.'
              : 'Connect the wallet to read balances.'
          }
        >
          {rows.map((line) => {
            const issuer = assetIssuer(line);
            return (
              <Tr key={`${line.type}:${line.asset}`}>
                <Td>
                  <strong>{assetCode(line)}</strong>
                </Td>
                <Td>
                  <Badge tone={line.type === 'native' ? 'accent' : 'neutral'}>
                    {KIND_LABEL[line.type]}
                  </Badge>
                </Td>
                <Td>
                  {issuer ? (
                    <AddressChip value={issuer} keep={5} />
                  ) : (
                    <Mono>—</Mono>
                  )}
                </Td>
                <Td align="right" mono>
                  {formatAmount(line.balance)}
                </Td>
              </Tr>
            );
          })}
        </DataTable>

        <AddTokenRow onSubmit={handle(trackToken)}>
          <Input
            mono
            placeholder="Track a Soroban token by contract id (C…)"
            aria-label="Token contract id"
            value={contractId}
            disabled={!connected || busy}
            onChange={(event) => setContractId(event.target.value)}
          />
          <Button
            type="submit"
            disabled={!connected || busy || !contractId.trim()}
          >
            Track token
          </Button>
        </AddTokenRow>
      </Stack>
    </Panel>
  );
};
