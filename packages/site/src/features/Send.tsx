import { Asset, Memo, Operation } from '@stellar/stellar-sdk/base';
import { useState } from 'react';
import type { BalanceLine } from 'stellar-soroban-snap-connector';

import type { Submission } from './Submission';
import { SubmissionResult } from './Submission';
import { Button, Field, FormRow, Input, Select } from '../components/Form';
import { Cluster, Panel, Stack } from '../components/Layout';
import { Alert } from '../components/Status';
import { useWallet } from '../hooks';
import {
  accountExists,
  assetCode,
  assetIssuer,
  baseAccount,
  formatAmount,
  handle,
  isValidDestination,
  MAX_MEMO_BYTES,
  memoByteLength,
  newBuilder,
  TX_TIMEOUT_SECONDS,
  validateAmount,
} from '../utils';

/**
 * The starting balance a `createAccount` must leave behind: two base reserves
 * at 0.5 XLM each. Below this the operation is rejected by the protocol, so
 * the form says so before the wallet has to.
 */
const MIN_STARTING_BALANCE = 1;

/**
 * Only assets the account can actually send are offered: the native balance
 * and its classic trustlines. Soroban tokens move by contract invocation, not
 * by the `payment` operation, so listing them here would build transactions
 * that cannot succeed.
 *
 * @param line - A balance row.
 * @returns True when the row is payable with a classic payment.
 */
const isPayable = (line: BalanceLine) =>
  line.type === 'native' || line.type === 'classic';

/**
 * The payment form: build a classic payment (or an account-creating payment),
 * have the wallet sign it, and let the wallet submit it.
 *
 * The envelope is assembled here and handed over as XDR. The wallet decodes
 * what it is asked to sign from that XDR rather than from anything this page
 * says about it, which is the property that makes the review dialog worth
 * reading. Submission is delegated with `submit: true` so the demo exercises
 * the wallet's own submission path, including the hash check it performs on
 * the response.
 *
 * @returns The send panel.
 */
export const Send = () => {
  const { ready, connected, busy, address, network, balances, run } =
    useWallet();

  const [destination, setDestination] = useState('');
  const [assetKey, setAssetKey] = useState('native');
  const [amountInput, setAmountInput] = useState('');
  const [memo, setMemo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission | null>(null);

  if (!ready) {
    return null;
  }

  const payable = (balances?.balances ?? []).filter(isPayable);
  const selected =
    payable.find((line) => `${line.type}:${line.asset}` === assetKey) ??
    payable[0];

  /**
   * Validates the form, builds the envelope, and hands it to the wallet.
   *
   * The destination existence check decides between `payment` and
   * `createAccount`: a payment to an account that does not exist fails at the
   * protocol level, and picking the wrong one is the most common way a first
   * transfer on Stellar fails. When the check itself cannot be completed the
   * form stops and says so, rather than guessing.
   */
  const submit = async () => {
    setProblem(null);
    setSubmission(null);

    const target = destination.trim();
    if (!isValidDestination(target)) {
      setProblem('Enter a valid destination address (G… or M…).');
      return;
    }
    // One value is validated and built with: the trimmed input. Validating
    // a trimmed copy and building with the raw field would let the two
    // drift apart.
    const amount = amountInput.trim();
    const amountProblem = validateAmount(amount);
    if (amountProblem) {
      setProblem(amountProblem);
      return;
    }
    if (memoByteLength(memo) > MAX_MEMO_BYTES) {
      setProblem(`The memo must be at most ${MAX_MEMO_BYTES} bytes of text.`);
      return;
    }
    if (!network || !balances?.sequence || !selected) {
      setProblem(
        'The account is not ready to send yet. Connect and fund it first.',
      );
      return;
    }

    const account = baseAccount(target);
    const exists = account
      ? await accountExists(network.networkUrl, account)
      : null;
    if (exists === null) {
      setProblem(
        'Could not reach Horizon to check whether the destination exists. Try again in a moment.',
      );
      return;
    }

    const isNative = selected.type === 'native';
    const issuer = assetIssuer(selected);
    const asset =
      isNative || !issuer
        ? Asset.native()
        : new Asset(assetCode(selected), issuer);

    if (!exists && !isNative) {
      setProblem(
        'The destination account does not exist yet. It must be created with XLM before it can hold other assets.',
      );
      return;
    }
    if (!exists && target !== account) {
      // Creating an account is a ledger operation on the base G… account: a
      // muxed sub-id has no meaning until the account exists, and the SDK
      // refuses to build createAccount with an M… destination. Refuse with
      // the remedy rather than guessing at intent (silently creating the
      // base account would drop the sub-id the sender typed).
      setProblem(
        'The destination account does not exist yet, and a new account cannot be created at a muxed (M…) address. Create it with its base G… address first, then send to the M… address.',
      );
      return;
    }
    if (!exists && Number.parseFloat(amount) < MIN_STARTING_BALANCE) {
      setProblem(
        `The destination account does not exist yet, so this payment creates it and must send at least ${MIN_STARTING_BALANCE} XLM.`,
      );
      return;
    }

    // The `handle()` wrapper this action runs under drops the returned
    // promise, so a throw while assembling the envelope would make the
    // button silently do nothing. Everything after this point that can throw
    // synchronously is converted into a visible problem instead.
    let envelope: string;
    try {
      const builder = newBuilder(
        address,
        balances.sequence,
        network.networkPassphrase,
      ).addOperation(
        exists
          ? Operation.payment({ destination: target, asset, amount })
          : Operation.createAccount({
              destination: target,
              startingBalance: amount,
            }),
      );
      if (memo) {
        builder.addMemo(Memo.text(memo));
      }
      envelope = builder.setTimeout(TX_TIMEOUT_SECONDS).build().toXDR();
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : 'Could not build the transaction.',
      );
      return;
    }

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
      setAmountInput('');
      setMemo('');
    }
  };

  const disabled = !connected || busy;

  return (
    <Panel
      id="send"
      title="Send a payment"
      description="Builds a classic payment, or an account-creating payment when the destination does not exist yet, and asks the wallet to sign and submit it."
    >
      <Stack gap="1.2rem">
        <div>
          <FormRow>
            <Field label="Destination">
              <Input
                mono
                placeholder="G… or M…"
                value={destination}
                disabled={disabled}
                onChange={(event) => setDestination(event.target.value)}
              />
            </Field>
          </FormRow>
          <FormRow>
            <Field label="Asset">
              <Select
                value={assetKey}
                disabled={disabled || payable.length === 0}
                onChange={(event) => setAssetKey(event.target.value)}
              >
                {payable.length === 0 ? (
                  <option value="native">XLM</option>
                ) : (
                  payable.map((line) => (
                    <option
                      key={`${line.type}:${line.asset}`}
                      value={`${line.type}:${line.asset}`}
                    >
                      {`${assetCode(line)} · ${formatAmount(line.balance)} available`}
                    </option>
                  ))
                )}
              </Select>
            </Field>
            <Field label="Amount">
              <Input
                inputMode="decimal"
                placeholder="0.0000000"
                value={amountInput}
                disabled={disabled}
                onChange={(event) => setAmountInput(event.target.value)}
              />
            </Field>
            <Field label="Memo" hint={`optional, ${MAX_MEMO_BYTES} bytes max`}>
              <Input
                placeholder="Reference"
                value={memo}
                disabled={disabled}
                onChange={(event) => setMemo(event.target.value)}
              />
            </Field>
          </FormRow>
          <Cluster>
            <Button
              variant="primary"
              disabled={disabled || !destination.trim() || !amountInput.trim()}
              onClick={handle(async () => submit())}
            >
              Review in MetaMask
            </Button>
            {network?.network === 'PUBLIC' ? (
              <Alert tone="warning">
                The wallet is on mainnet. This moves real funds.
              </Alert>
            ) : null}
          </Cluster>
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
