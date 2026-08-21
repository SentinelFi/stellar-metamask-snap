import { Asset, Operation, StrKey } from '@stellar/stellar-sdk/base';
import { useState } from 'react';

import type { Submission } from './Submission';
import { SubmissionResult } from './Submission';
import { Button, Field, FormRow, Input } from '../components/Form';
import { Panel, Stack } from '../components/Layout';
import { Alert, AddressChip } from '../components/Status';
import { DataTable, Td, Tr } from '../components/Table';
import { useWallet } from '../hooks';
import {
  assetCode,
  assetIssuer,
  formatAmount,
  handle,
  newBuilder,
  TX_TIMEOUT_SECONDS,
} from '../utils';

/** Classic asset codes are 1 to 12 alphanumeric characters. */
const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/u;

const COLUMNS = [
  { key: 'asset', label: 'Asset' },
  { key: 'issuer', label: 'Issuer' },
  { key: 'balance', label: 'Balance', align: 'right' as const },
  { key: 'actions', label: '', align: 'right' as const },
];

/**
 * Trustline management: open a trustline to a classic asset, and close one
 * that is no longer needed.
 *
 * Closing is a `changeTrust` with a zero limit, which the protocol accepts
 * only when the balance is already zero, so the control is offered only on
 * empty lines. A button that could only fail is worse than no button: the
 * user cannot tell a protocol rule from a broken demo.
 *
 * @returns The trustlines panel.
 */
export const Trustlines = () => {
  const { ready, connected, busy, address, network, balances, run } =
    useWallet();

  const [code, setCode] = useState('');
  const [issuer, setIssuer] = useState('');
  const [limit, setLimit] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);

  if (!ready) {
    return null;
  }

  const lines = (balances?.balances ?? []).filter(
    (line) => line.type === 'classic',
  );

  /**
   * Signs and submits a single `changeTrust` operation.
   *
   * @param asset - The asset the trustline is for.
   * @param trustLimit - The limit; `'0'` closes the line.
   */
  const changeTrust = async (asset: Asset, trustLimit?: string) => {
    setProblem(null);
    setSubmission(null);
    if (!network || !balances?.sequence) {
      setProblem('Connect and fund the account before changing trustlines.');
      return;
    }

    const envelope = newBuilder(
      address,
      balances.sequence,
      network.networkPassphrase,
    )
      .addOperation(
        Operation.changeTrust({
          asset,
          ...(trustLimit === undefined ? {} : { limit: trustLimit }),
        }),
      )
      .setTimeout(TX_TIMEOUT_SECONDS)
      .build()
      .toXDR();

    const result = await run(async (client) =>
      client.signTransaction(envelope, {
        submit: true,
        // The wallet requires the caller to state the network on PUBLIC, so
        // both sides can confirm they mean the same one before a mainnet
        // signature is produced.
        networkPassphrase: network.networkPassphrase,
      }),
    );
    if (result) {
      setSubmission({
        hash: result.hash,
        status: result.status,
        warnings: result.warnings,
      });
      setCode('');
      setIssuer('');
      setLimit('');
    }
  };

  /** Validates the add form, then opens the trustline. */
  const addTrustline = async () => {
    const assetCodeValue = code.trim();
    const issuerValue = issuer.trim();
    if (!ASSET_CODE_PATTERN.test(assetCodeValue)) {
      setProblem('Asset codes are 1 to 12 letters or digits.');
      return;
    }
    if (!StrKey.isValidEd25519PublicKey(issuerValue)) {
      setProblem('Enter a valid issuer account (G…).');
      return;
    }
    if (limit.trim() && !/^\d{1,15}(?:\.\d{1,7})?$/u.test(limit.trim())) {
      setProblem('The limit must be a number with at most 7 decimal places.');
      return;
    }
    await changeTrust(
      new Asset(assetCodeValue, issuerValue),
      limit.trim() || undefined,
    );
  };

  const disabled = !connected || busy;

  return (
    <Panel
      id="trustlines"
      title="Trustlines"
      description="A classic asset can only be held once the account trusts its issuer. Opening a trustline reserves 0.5 XLM until it is closed."
    >
      <Stack gap="1.2rem">
        <DataTable
          columns={COLUMNS}
          hasRows={lines.length > 0}
          empty={
            connected
              ? 'No trustlines yet. Open one below to hold an issued asset.'
              : 'Connect the wallet to see trustlines.'
          }
        >
          {lines.map((line) => {
            const lineIssuer = assetIssuer(line);
            const empty = Number.parseFloat(line.balance) === 0;
            return (
              <Tr key={line.asset}>
                <Td>
                  <strong>{assetCode(line)}</strong>
                </Td>
                <Td>
                  {lineIssuer ? (
                    <AddressChip value={lineIssuer} keep={5} />
                  ) : (
                    '—'
                  )}
                </Td>
                <Td align="right" mono>
                  {formatAmount(line.balance)}
                </Td>
                <Td align="right">
                  <Button
                    small
                    variant="danger"
                    disabled={disabled || !empty || !lineIssuer}
                    title={
                      empty
                        ? 'Close this trustline'
                        : 'The balance must be zero before a trustline can be closed'
                    }
                    onClick={handle(async () =>
                      changeTrust(
                        new Asset(assetCode(line), lineIssuer ?? ''),
                        '0',
                      ),
                    )}
                  >
                    Close
                  </Button>
                </Td>
              </Tr>
            );
          })}
        </DataTable>

        <div>
          <FormRow>
            <Field label="Asset code">
              <Input
                placeholder="USDC"
                value={code}
                disabled={disabled}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <Field label="Issuer">
              <Input
                mono
                placeholder="G…"
                value={issuer}
                disabled={disabled}
                onChange={(event) => setIssuer(event.target.value)}
              />
            </Field>
            <Field label="Limit" hint="optional, defaults to the maximum">
              <Input
                inputMode="decimal"
                placeholder="Unlimited"
                value={limit}
                disabled={disabled}
                onChange={(event) => setLimit(event.target.value)}
              />
            </Field>
          </FormRow>
          <Button
            variant="primary"
            disabled={disabled || !code.trim() || !issuer.trim()}
            onClick={handle(async () => addTrustline())}
          >
            Open trustline
          </Button>
        </div>

        {problem ? (
          <Alert tone="error" onDismiss={() => setProblem(null)}>
            {problem}
          </Alert>
        ) : null}
        <SubmissionResult
          submission={submission}
          network={network?.network ?? null}
          onDismiss={() => setSubmission(null)}
        />
      </Stack>
    </Panel>
  );
};
