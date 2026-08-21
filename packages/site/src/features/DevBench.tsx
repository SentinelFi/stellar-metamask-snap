import {
  Address,
  Asset,
  Operation,
  SorobanDataBuilder,
  xdr,
} from '@stellar/stellar-sdk/base';
import { Fragment, useState } from 'react';
import type { StellarSnap } from 'stellar-soroban-snap-connector';
import styled from 'styled-components';

import { Button } from '../components/Form';
import { Cluster, Panel, Stack } from '../components/Layout';
import { CodeBlock } from '../components/Status';
import { useWallet } from '../hooks';
import { handle, newBuilder, TX_TIMEOUT_SECONDS } from '../utils';

/**
 * Known Stellar Asset Contract addresses, handy when trying the token
 * tracking control in the Balances panel.
 *
 * Provenance: these are the well-known SAC contract IDs, each deterministic
 * for its asset and network and derivable as
 * `Asset.contractId(networkPassphrase)` (for XLM via `Asset.native()`, for
 * USDC from Circle's issuer account). They are display-only here, but users
 * are invited to paste them into the token control, so a wrong ID would steer
 * users into tracking an attacker's token contract. Anyone editing this list
 * must re-derive the IDs with the SDK or verify them against the Stellar
 * asset lists or stellar.expert before shipping the change.
 */
const REFERENCE_ASSETS: { label: string; contractId: string }[] = [
  {
    label: 'Testnet USDC',
    contractId: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  },
  {
    label: 'Mainnet USDC',
    contractId: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
  },
  {
    label: 'Testnet XLM',
    contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  },
  {
    label: 'Mainnet XLM',
    contractId: 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA',
  },
];

const ReferenceList = styled.dl`
  margin: 0;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.4rem 1.6rem;
  align-items: baseline;
  font-size: ${({ theme }) => theme.fontSizes.small};

  & dt {
    font-weight: 600;
    white-space: nowrap;
  }

  & dd {
    margin: 0;
    font-family: ${({ theme }) => theme.fonts.code};
    font-size: ${({ theme }) => theme.fontSizes.tiny};
    word-break: break-all;
    color: ${({ theme }) => theme.colors.text?.muted};
  }

  ${({ theme }) => theme.mediaQueries.small} {
    grid-template-columns: 1fr;
  }
`;

/**
 * The raw connector surface: every SEP-43 method, called directly, with the
 * JSON response shown verbatim.
 *
 * The panels above are the product; this is the test bench underneath them.
 * It exists so a reviewer can exercise a method without a form standing in
 * the way, and so the shapes the connector actually returns are visible
 * rather than described.
 *
 * It is a development surface and is mounted only when `GATSBY_DEV_BENCH` is
 * `true` (see `devBenchEnabled` in `config/snap.ts`); the production build
 * guard refuses that flag, so a released page never renders it.
 *
 * @returns The developer panel.
 */
export const DevBench = () => {
  const { ready, connected, busy, address, network, balances, run } =
    useWallet();
  const [result, setResult] = useState<string | null>(null);

  if (!ready) {
    return null;
  }

  /**
   * Runs a connector call and renders its JSON result.
   *
   * @param work - The call to run.
   */
  const show = async (work: (client: StellarSnap) => Promise<unknown>) => {
    const value = await run(work);
    if (value !== null) {
      setResult(JSON.stringify(value, null, 2));
    }
  };

  /**
   * Builds a self-directed SAC transfer and asks for a signature without
   * submitting it. This is the shortest path to the Soroban review dialog:
   * the decoded invocation, the footprint, the simulation, and the balance
   * changes the simulation reports.
   *
   * @returns Nothing; the response is rendered as JSON below the controls.
   */
  const signSorobanInvoke = async () =>
    show(async (client) => {
      if (!network || !balances) {
        throw new Error('Connect the wallet first.');
      }
      const contract = Asset.native().contractId(network.networkPassphrase);
      // The wallet refuses Soroban envelopes without a footprint, since their
      // signed state-access scope would be invisible in review. A real dapp
      // gets one from `simulateTransaction`; the demo attaches a minimal one
      // covering the contract instance.
      const footprint = [
        xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: new Address(contract).toScAddress(),
            key: xdr.ScVal.scvLedgerKeyContractInstance(),
            durability: xdr.ContractDataDurability.persistent(),
          }),
        ),
      ];
      const envelope = newBuilder(
        address,
        balances.sequence ?? '1',
        network.networkPassphrase,
      )
        .addOperation(
          Operation.invokeContractFunction({
            contract,
            function: 'transfer',
            args: [
              new Address(address).toScVal(),
              new Address(address).toScVal(),
              xdr.ScVal.scvI128(
                new xdr.Int128Parts({
                  hi: new xdr.Int64(0n),
                  lo: new xdr.Uint64(10000000n),
                }),
              ),
            ],
          }),
        )
        .setSorobanData(
          new SorobanDataBuilder()
            .setFootprint(footprint, [])
            .setResourceFee(1000000n)
            .build(),
        )
        .setTimeout(TX_TIMEOUT_SECONDS)
        .build()
        .toXDR();

      return client.signTransaction(envelope, {
        // Stated for the same reason the production flows state it: the
        // wallet requires the caller's network on PUBLIC before signing.
        networkPassphrase: network.networkPassphrase,
      });
    });

  return (
    <Panel
      id="developer"
      muted
      title="Connector bench"
      description="Calls the SEP-43 methods directly and shows the raw response. This is the manual test surface for the connector package."
    >
      <Stack gap="1.6rem">
        <Cluster gap="0.8rem">
          <Button
            small
            disabled={busy}
            onClick={handle(async () =>
              show(async (client) => client.requestAccess()),
            )}
          >
            requestAccess
          </Button>
          <Button
            small
            disabled={busy}
            onClick={handle(async () =>
              show(async (client) => client.getAddress()),
            )}
          >
            getAddress
          </Button>
          <Button
            small
            disabled={busy}
            onClick={handle(async () =>
              show(async (client) => client.getNetworkDetails()),
            )}
          >
            getNetworkDetails
          </Button>
          <Button
            small
            disabled={!connected || busy}
            onClick={handle(async () =>
              show(async (client) => client.getAccounts()),
            )}
          >
            getAccounts
          </Button>
          <Button
            small
            disabled={!connected || busy}
            onClick={handle(async () =>
              show(async (client) => client.getBalances()),
            )}
          >
            getBalances
          </Button>
          <Button
            small
            disabled={busy}
            onClick={handle(async () =>
              show(async (client) =>
                client.signMessage('Hello from the Stellar Soroban Snap!'),
              ),
            )}
          >
            signMessage
          </Button>
          <Button
            small
            disabled={!connected || busy || !balances?.sequence}
            onClick={handle(signSorobanInvoke)}
          >
            signTransaction (Soroban)
          </Button>
        </Cluster>

        {result ? (
          <div>
            <CodeBlock>{result}</CodeBlock>
            <Cluster gap="0.8rem">
              <Button small variant="ghost" onClick={() => setResult(null)}>
                Clear
              </Button>
            </Cluster>
          </div>
        ) : null}

        <div>
          <ReferenceList>
            {REFERENCE_ASSETS.map((asset) => (
              <Fragment key={asset.contractId}>
                <dt>{asset.label}</dt>
                <dd>{asset.contractId}</dd>
              </Fragment>
            ))}
          </ReferenceList>
        </div>
      </Stack>
    </Panel>
  );
};
