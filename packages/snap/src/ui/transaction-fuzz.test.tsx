import { describe, expect, it } from '@jest/globals';
import {
  Account,
  Address,
  Asset,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';

import { containsHiddenCharacters } from './format';
import { buildSignTransactionDialog } from './transaction';

/*
 * Property tests over the transaction dialog, the surface the
 * display-integrity claim ultimately reaches the user through
 * (docs/THREAT-MODEL.md claim 2). Randomized and mutated envelopes, three
 * invariants:
 *
 *   1. Never throws. The dialog is built after the handler's fail-closed
 *      gates, so a throw here is a signable transaction that cannot be
 *      reviewed.
 *   2. No hidden characters in inline text. Anything rendered in a `Text`,
 *      `Row` label, or `Banner` title must be free of controls, bidi
 *      overrides, and zero-width marks, so the dialog cannot be made to read
 *      differently from what is signed. `Copyable` is deliberately exempt:
 *      it renders verbatim and ignores markup, which is why free-form values
 *      are routed there.
 *   3. The raw XDR is always present, so the user retains a source of truth
 *      no rendering choice can take away.
 *
 * Generation is seeded over a fixed range, so the corpus is identical on
 * every run and a failure reproduces from its seed.
 */

const SOURCE = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const OTHER = 'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const ISSUER = 'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';

const CASES = 200;

/**
 * Deterministic PRNG (Park-Miller), so a failing case reproduces from its
 * seed rather than being a flake.
 *
 * The seed is scrambled and the stream warmed up before use: seeded with
 * small sequential integers, Park-Miller yields a near-zero first output for
 * every seed, which collapses the corpus to a single branch.
 * `corpusCoverage` below guards against that regressing.
 *
 * @param seed - The seed value.
 * @returns A function yielding floats in [0, 1).
 */
function makeRng(seed: number): () => number {
  let state = (seed * 48271 + 11) % 2147483647;
  if (state <= 0) {
    state += 2147483646;
  }
  for (let warmup = 0; warmup < 15; warmup++) {
    state = (state * 16807) % 2147483647;
  }
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/** A property failure, reported with the seed that produced it. */
type Violation = { seed: number; property: string; detail: string };

/**
 * Picks a random element.
 *
 * @param rng - The random source.
 * @param values - Candidates.
 * @returns One element.
 */
function pick<Type>(rng: () => number, values: readonly Type[]): Type {
  return values[Math.floor(rng() * values.length)] as Type;
}

/**
 * Strings chosen to attack the dialog: forged rows, direction and visibility
 * tricks, and markup.
 */
const HOSTILE_TEXT = [
  '',
  'ordinary memo',
  'two\nlines',
  'tab\tsep',
  '‮gnp.txt',
  '​zero​width',
  '⁦isolate⁩',
  '﻿bom',
  '**bold**',
  'Amount: 1000 XLM',
  'To: GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
  '"quoted"',
  'ünïcödé',
  '🙂',
  'x'.repeat(200),
] as const;

/**
 * Builds a random operation from the set the snap renders.
 *
 * @param rng - The random source.
 * @returns The operation.
 */
function randomOperation(rng: () => number) {
  const hostile = () => pick(rng, HOSTILE_TEXT);
  const asset = () =>
    pick(rng, [
      Asset.native(),
      new Asset('USDC', ISSUER),
      new Asset('LONGASSET12', ISSUER),
    ]);
  const amount = () => pick(rng, ['1', '0.0000001', '922337203685.4775807']);

  switch (
    pick(rng, [
      'payment',
      'createAccount',
      'changeTrust',
      'pathPaymentStrictSend',
      'pathPaymentStrictReceive',
      'manageData',
      'setOptions',
      'accountMerge',
      'extendFootprintTtl',
      'restoreFootprint',
    ])
  ) {
    case 'payment':
      return Operation.payment({
        destination: pick(rng, [OTHER, ISSUER]),
        asset: asset(),
        amount: amount(),
      });
    case 'createAccount':
      return Operation.createAccount({
        destination: pick(rng, [OTHER, ISSUER]),
        startingBalance: amount(),
      });
    case 'changeTrust':
      return Operation.changeTrust({ asset: asset() });
    case 'pathPaymentStrictSend':
      return Operation.pathPaymentStrictSend({
        sendAsset: asset(),
        sendAmount: amount(),
        destination: OTHER,
        destAsset: asset(),
        destMin: amount(),
        path: [asset()],
      });
    case 'pathPaymentStrictReceive':
      return Operation.pathPaymentStrictReceive({
        sendAsset: asset(),
        sendMax: amount(),
        destination: OTHER,
        destAsset: asset(),
        destAmount: amount(),
        path: [asset()],
      });
    case 'manageData':
      // Both the name and the value are attacker-chosen.
      return Operation.manageData({
        name: hostile().slice(0, 64) || 'k',
        value: pick(rng, [
          null,
          Buffer.from(hostile().slice(0, 60), 'utf8'),
          Buffer.from([0, 1, 2, 255]),
        ]),
      });
    case 'setOptions':
      return Operation.setOptions({
        homeDomain: hostile().slice(0, 32),
        ...(rng() < 0.5
          ? {
              signer: {
                ed25519PublicKey: OTHER,
                weight: Math.floor(rng() * 255),
              },
            }
          : {}),
      });
    case 'accountMerge':
      return Operation.accountMerge({ destination: OTHER });
    case 'extendFootprintTtl':
      return Operation.extendFootprintTtl({
        extendTo: Math.floor(rng() * 100000) + 1,
      });
    case 'restoreFootprint':
    default:
      return Operation.restoreFootprint({});
  }
}

/**
 * Builds a random transaction envelope, round-tripped through XDR so the
 * dialog receives exactly what the handler would after parsing.
 *
 * @param rng - The random source.
 * @returns The parsed transaction and its base64 envelope.
 */
function randomTransaction(rng: () => number) {
  const builder = new TransactionBuilder(
    new Account(SOURCE, String(Math.floor(rng() * 1e6))),
    {
      fee: pick(rng, ['100', '10000', '1000000']),
      networkPassphrase: Networks.TESTNET,
      memo: pick(rng, [
        Memo.none(),
        Memo.text(pick(rng, HOSTILE_TEXT).slice(0, 28)),
        Memo.id(String(Math.floor(rng() * 1e9))),
        Memo.hash(Buffer.alloc(32, Math.floor(rng() * 256))),
      ]),
    },
  );
  const count = 1 + Math.floor(rng() * 3);
  for (let index = 0; index < count; index++) {
    builder.addOperation(randomOperation(rng));
  }
  const built = builder.setTimeout(300).build();
  const envelope = built.toXDR();
  return {
    tx: TransactionBuilder.fromXDR(envelope, Networks.TESTNET),
    xdr: envelope,
  };
}

/** A rendered JSX node, as the snaps SDK models it. */
type Node = {
  type?: string;
  props?: Record<string, unknown>;
};

/**
 * Collects every string the dialog renders as inline text.
 *
 * `Copyable` subtrees are skipped on purpose: that component renders its
 * value verbatim and ignores markup, which is exactly why the free-form
 * fields are routed there. Everything else (`Text` children, `Row` labels,
 * `Banner` titles) is inline text that must already be sanitized.
 *
 * @param node - The node to walk.
 * @param out - Accumulator.
 * @returns The collected strings.
 */
function collectInlineText(node: unknown, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectInlineText(child, out);
    }
    return out;
  }
  if (!node || typeof node !== 'object') {
    return out;
  }

  const element = node as Node;
  if (element.type === 'Copyable') {
    return out;
  }
  const props = element.props ?? {};
  for (const key of ['label', 'title', 'alt']) {
    const value = props[key];
    if (typeof value === 'string') {
      out.push(value);
    }
  }
  collectInlineText(props.children, out);
  return out;
}

/**
 * Collects every `Copyable` value in the dialog.
 *
 * @param node - The node to walk.
 * @param out - Accumulator.
 * @returns The collected values.
 */
function collectCopyable(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const child of node) {
      collectCopyable(child, out);
    }
    return out;
  }
  if (!node || typeof node !== 'object') {
    return out;
  }
  const element = node as Node;
  const props = element.props ?? {};
  if (element.type === 'Copyable' && typeof props.value === 'string') {
    out.push(props.value);
  }
  collectCopyable(props.children, out);
  return out;
}

describe('walker self-check', () => {
  /*
   * The invariants above are only as good as the walker that feeds them. A
   * collector that silently returned nothing would make every assertion pass
   * while checking nothing at all, so pin its behavior directly.
   */

  const sample = () => {
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      memo: Memo.text('a memo'),
    })
      .addOperation(
        Operation.payment({
          destination: OTHER,
          asset: new Asset('USDC', ISSUER),
          amount: '10',
        }),
      )
      .setTimeout(300)
      .build();
    return buildSignTransactionDialog({
      origin: 'https://dapp.example',
      network: 'PUBLIC',
      tx,
      xdr: tx.toXDR(),
      signingAddress: SOURCE,
      accountIndex: 3,
    });
  };

  it('reaches nested text, row labels, and banner titles', () => {
    const inline = collectInlineText(sample());
    expect(inline.length).toBeGreaterThan(10);
    // Text child nested inside Bold inside Text.
    expect(inline.join('\n')).toContain('Payment');
    // Row label.
    expect(inline).toContain('Signing with');
    // Interpolated Text child.
    expect(inline.join('\n')).toContain('Account 3');
    // Banner title.
    expect(inline).toContain('Mainnet');
  });

  it('skips Copyable subtrees but still finds their values separately', () => {
    const inline = collectInlineText(sample());
    const copyable = collectCopyable(sample());
    // The signing address is rendered only in a Copyable, so it must appear
    // in one collector and not the other.
    expect(copyable).toContain(SOURCE);
    expect(inline).not.toContain(SOURCE);
  });

  it('detects a hidden character when one is present', () => {
    // Negative control: feed the collector a tree that does carry a bidi
    // override and confirm the invariant would fail rather than pass.
    const hostile = {
      type: 'Box',
      props: {
        children: [
          { type: 'Text', props: { children: 'safe' } },
          { type: 'Row', props: { label: 'evil‮label', children: [] } },
          { type: 'Copyable', props: { value: 'verbatim‮value' } },
        ],
      },
    };
    const inline = collectInlineText(hostile);
    expect(inline.some((text) => containsHiddenCharacters(text))).toBe(true);
    // And the Copyable value is excluded, as the exemption intends.
    expect(inline.join('')).not.toContain('verbatim');
  });
});

/**
 * Checks one rendered dialog against invariants 1 to 3.
 *
 * @param seed - The seed that produced this case, for reporting.
 * @param build - Builds the dialog; a throw is invariant-1 failure.
 * @param envelope - The envelope XDR that must remain on offer.
 * @returns The violations found (empty when the dialog is sound).
 */
function checkDialog(
  seed: number,
  build: () => unknown,
  envelope: string,
): Violation[] {
  const found: Violation[] = [];

  let content: unknown;
  try {
    content = build();
  } catch (error) {
    return [{ seed, property: 'never throws', detail: String(error) }];
  }

  const dirty = collectInlineText(content).find((text) =>
    containsHiddenCharacters(text),
  );
  if (dirty !== undefined) {
    found.push({
      seed,
      property: 'no hidden characters in inline text',
      detail: JSON.stringify(dirty.slice(0, 120)),
    });
  }

  if (!collectCopyable(content).includes(envelope)) {
    found.push({
      seed,
      property: 'raw XDR is always offered',
      detail: 'envelope missing from Copyable values',
    });
  }

  return found;
}

/**
 * Walks the generated transaction corpus.
 *
 * @returns The violations (empty when every dialog is sound).
 */
function dialogViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < CASES; seed++) {
    const rng = makeRng(seed);
    const { tx, xdr: envelope } = randomTransaction(rng);
    const origin = pick(rng, [
      'https://dapp.example',
      'https://xn--80ak6aa92e.example',
      `https://${'long'.repeat(40)}.example`,
      'https://evil‮example.com',
    ]);
    const network = pick(rng, ['TESTNET', 'PUBLIC', 'FUTURENET'] as const);
    const accountIndex = Math.floor(rng() * 5);
    const warnings = rng() < 0.5 ? ['A safety warning'] : [];
    const submit = rng() < 0.5;

    found.push(
      ...checkDialog(
        seed,
        () =>
          buildSignTransactionDialog({
            origin,
            network,
            tx,
            xdr: envelope,
            signingAddress: SOURCE,
            accountIndex,
            simulation: null,
            warnings,
            submit,
          }),
        envelope,
      ),
    );
  }
  return found;
}

describe('transaction dialog properties', () => {
  it('holds all three invariants across the generated corpus', () => {
    expect(dialogViolations()).toStrictEqual([]);
  });

  it('warns when a rendered field carried hidden characters', () => {
    // The dialog sanitizes for display, so the user must additionally be told
    // that the display and the signed bytes differ. Without the banner, a
    // sanitized rendering is silently lossy.
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
      memo: Memo.text('safe‮looking'),
    })
      .addOperation(
        Operation.payment({
          destination: OTHER,
          asset: Asset.native(),
          amount: '1',
        }),
      )
      .setTimeout(300)
      .build();

    const content = buildSignTransactionDialog({
      origin: 'https://dapp.example',
      network: 'TESTNET',
      tx,
      xdr: tx.toXDR(),
      signingAddress: SOURCE,
      accountIndex: 0,
    });

    expect(collectInlineText(content).join('\n')).toContain(
      'Display differs from signed text',
    );
    expect(
      collectInlineText(content).filter((text) =>
        containsHiddenCharacters(text),
      ),
    ).toStrictEqual([]);
  });
});

/**
 * Mutates a valid envelope by replacing a few bytes, then renders whatever
 * still parses.
 *
 * Most mutations fail to parse, which the handler turns into a SEP-43 error.
 * The ones that do parse are the interesting cases: near-valid structures
 * that must still render within the invariants rather than producing an
 * unreviewable dialog.
 *
 * @returns The violations, plus how many mutants actually parsed.
 */
function mutationViolations(): { found: Violation[]; parsed: number } {
  const base = new TransactionBuilder(new Account(SOURCE, '1'), {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
    memo: Memo.text('base memo'),
  })
    .addOperation(
      Operation.payment({
        destination: OTHER,
        asset: new Asset('USDC', ISSUER),
        amount: '10',
      }),
    )
    .addOperation(Operation.manageData({ name: 'key', value: 'value' }))
    .setTimeout(300)
    .build();
  const raw = base.toEnvelope().toXDR();

  const found: Violation[] = [];
  let parsed = 0;
  for (let seed = 0; seed < 500; seed++) {
    const rng = makeRng(seed);
    const mutated = Buffer.from(raw);
    const edits = 1 + Math.floor(rng() * 3);
    for (let edit = 0; edit < edits; edit++) {
      mutated[Math.floor(rng() * mutated.length)] = Math.floor(rng() * 256);
    }
    const envelope = mutated.toString('base64');

    let tx;
    try {
      tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
    } catch {
      continue;
    }
    parsed += 1;
    found.push(
      ...checkDialog(
        seed,
        () =>
          buildSignTransactionDialog({
            origin: 'https://dapp.example',
            network: 'TESTNET',
            tx,
            xdr: envelope,
            signingAddress: SOURCE,
            accountIndex: 0,
          }),
        envelope,
      ),
    );
  }
  return { found, parsed };
}

/**
 * Feeds random bytes to the envelope parser.
 *
 * @returns The violations (empty when every input is rejected or renders).
 */
function randomEnvelopeViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < 200; seed++) {
    const rng = makeRng(seed);
    const bytes = Buffer.from(
      Array.from({ length: Math.floor(rng() * 300) }, () =>
        Math.floor(rng() * 256),
      ),
    );
    const envelope = bytes.toString('base64');

    let tx;
    try {
      tx = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);
    } catch (error) {
      if (!(error instanceof Error)) {
        found.push({
          seed,
          property: 'parse throws only Errors',
          detail: String(error),
        });
      }
      continue;
    }
    // A random buffer parsing is rare but legal; it must still render.
    found.push(
      ...checkDialog(
        seed,
        () =>
          buildSignTransactionDialog({
            origin: 'https://dapp.example',
            network: 'TESTNET',
            tx,
            xdr: envelope,
            signingAddress: SOURCE,
            accountIndex: 0,
          }),
        envelope,
      ),
    );
  }
  return found;
}

describe('mutated envelope XDR', () => {
  it('either fails to parse or renders within the invariants', () => {
    const { found, parsed } = mutationViolations();
    expect(found).toStrictEqual([]);
    // Guard against the corpus silently becoming all-rejects, which would
    // make the assertion above vacuous.
    expect(parsed).toBeGreaterThan(10);
  });

  it('rejects random bytes as an envelope', () => {
    expect(randomEnvelopeViolations()).toStrictEqual([]);
  });
});

describe('Soroban invocation dialogs', () => {
  const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

  /**
   * Builds an invokeHostFunction transaction with attacker-chosen function
   * names, arguments, and authorization entries.
   *
   * @param rng - The random source.
   * @returns The parsed transaction and its envelope XDR.
   */
  function sorobanTransaction(rng: () => number) {
    const args = Array.from({ length: Math.floor(rng() * 4) }, () =>
      pick(rng, [
        xdr.ScVal.scvString(pick(rng, HOSTILE_TEXT)),
        xdr.ScVal.scvSymbol(pick(rng, HOSTILE_TEXT).slice(0, 32)),
        xdr.ScVal.scvU32(Math.floor(rng() * 1e6)),
        new Address(OTHER).toScVal(),
        xdr.ScVal.scvBytes(Buffer.alloc(Math.floor(rng() * 100), 7)),
      ]),
    );

    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(CONTRACT).toScAddress(),
        // The function name is attacker-chosen and rendered inline.
        functionName: pick(rng, HOSTILE_TEXT).slice(0, 32),
        args,
      }),
    );

    const auth =
      rng() < 0.5
        ? [
            new xdr.SorobanAuthorizationEntry({
              credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
                new xdr.SorobanAddressCredentials({
                  address: new Address(OTHER).toScAddress(),
                  nonce: xdr.Int64.fromString('1'),
                  signatureExpirationLedger: 1000,
                  signature: xdr.ScVal.scvVoid(),
                }),
              ),
              rootInvocation: new xdr.SorobanAuthorizedInvocation({
                function:
                  xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
                    new xdr.InvokeContractArgs({
                      contractAddress: new Address(CONTRACT).toScAddress(),
                      functionName: pick(rng, HOSTILE_TEXT).slice(0, 32),
                      args,
                    }),
                  ),
                subInvocations: [],
              }),
            }),
          ]
        : [];

    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth }))
      .setTimeout(300)
      .build();
    const envelope = tx.toXDR();
    return {
      tx: TransactionBuilder.fromXDR(envelope, Networks.TESTNET),
      xdr: envelope,
    };
  }

  /**
   * Walks the Soroban corpus.
   *
   * @returns The violations (empty when every dialog is sound).
   */
  function sorobanViolations(): Violation[] {
    const found: Violation[] = [];
    for (let seed = 0; seed < 120; seed++) {
      const { tx, xdr: envelope } = sorobanTransaction(makeRng(seed));
      found.push(
        ...checkDialog(
          seed,
          () =>
            buildSignTransactionDialog({
              origin: 'https://dapp.example',
              network: 'TESTNET',
              tx,
              xdr: envelope,
              signingAddress: SOURCE,
              accountIndex: 0,
              simulation: null,
            }),
          envelope,
        ),
      );
    }
    return found;
  }

  it('holds the invariants for contract invocations', () => {
    expect(sorobanViolations()).toStrictEqual([]);
  });

  it('renders a hostile function name without letting it forge a row', () => {
    // A function name carrying a newline and a fake label must not become a
    // second dialog line that reads like a real field.
    const func = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(CONTRACT).toScAddress(),
        functionName: 'ok\nAmount: 1000',
        args: [],
      }),
    );
    const tx = new TransactionBuilder(new Account(SOURCE, '1'), {
      fee: '100000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.invokeHostFunction({ func, auth: [] }))
      .setTimeout(300)
      .build();

    const content = buildSignTransactionDialog({
      origin: 'https://dapp.example',
      network: 'TESTNET',
      tx: TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET),
      xdr: tx.toXDR(),
      signingAddress: SOURCE,
      accountIndex: 0,
      simulation: null,
    });

    const inline = collectInlineText(content);
    expect(
      inline.filter((text) => containsHiddenCharacters(text)),
    ).toStrictEqual([]);
    // No rendered string may carry a real line break: that is what would
    // split one value across two apparent dialog lines.
    expect(inline.filter((text) => text.includes('\n'))).toStrictEqual([]);
    // The name is shown quoted, with the break as a visible escape, so it
    // reads as one value rather than as an extra field. The backslash that
    // JSON.stringify introduces for the newline is itself escaped by
    // escapeHiddenCharacters (which doubles backslashes so its encoding is
    // injective), hence the four-backslash source literal here.
    expect(inline).toContain('"ok\\\\nAmount: 1000"');
  });
});

/**
 * Wraps generated transactions in fee bumps and renders them.
 *
 * A fee bump moves the operations into an inner envelope, so the dialog has
 * to reach through one more layer to review the same content.
 *
 * @returns The violations (empty when every dialog is sound).
 */
function feeBumpViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < 50; seed++) {
    const { tx: inner } = randomTransaction(makeRng(seed));
    // The bump's base fee must clear the inner transaction's own fee, which
    // the generator varies.
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.fromPublicKey(OTHER),
      String(Number(inner.fee) * 4 + 1_000_000),
      inner as never,
      Networks.TESTNET,
    );
    const envelope = feeBump.toXDR();
    const parsed = TransactionBuilder.fromXDR(envelope, Networks.TESTNET);

    found.push(
      ...checkDialog(
        seed,
        () =>
          buildSignTransactionDialog({
            origin: 'https://dapp.example',
            network: 'TESTNET',
            tx: parsed,
            xdr: envelope,
            signingAddress: SOURCE,
            accountIndex: 0,
          }),
        envelope,
      ),
    );
  }
  return found;
}

describe('fee-bump envelopes', () => {
  it('renders the inner transaction within the invariants', () => {
    expect(feeBumpViolations()).toStrictEqual([]);
  });
});
