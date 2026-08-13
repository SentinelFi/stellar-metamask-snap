import { describe, expect, it } from '@jest/globals';
import { Address, nativeToScVal, xdr } from '@stellar/stellar-sdk';

import {
  decodeAuthEntry,
  decodeHostFunction,
  findUndisplayableAuthEntry,
  formatScVal,
  formatSymbolName,
  MAX_INVOCATION_DEPTH,
  MAX_INVOCATION_NODES,
  summarizeAuthEntries,
} from './soroban';
import { containsHiddenCharacters } from '../ui/format';

/*
 * Property tests over the decoders the display-integrity claim rests on
 * (docs/THREAT-MODEL.md claim 2). Randomized input, three invariants:
 *
 *   1. Never throws unhandled. A decoder throwing where the caller does not
 *      expect it turns a hostile value into a failed request at best.
 *   2. Never emits hidden characters. Rendered text must not carry controls,
 *      bidi overrides, or zero-width marks that make the dialog read
 *      differently from what is signed.
 *   3. Fails closed. Every rendering limit and unknown variant must set the
 *      truncation flag, because the signing paths refuse on that flag. A
 *      display that silently drops content is the failure this guards.
 *
 * Each property walks its corpus in a module-scope helper that returns the
 * violations it found, so the test body is a single assertion against an
 * empty list and a failure names the exact seeds. Generation is seeded over
 * a fixed range, so the corpus is identical on every run and in CI: a
 * failure reproduces from its seed rather than being a flake.
 */

const ACCOUNT = 'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

/** Iterations per property. Each is cheap; the whole file stays seconds. */
const CASES = 300;

/**
 * Deterministic PRNG (Park-Miller). Seeded so a failing case reproduces
 * exactly from the seed the assertion reports.
 *
 * The seed is scrambled and the stream warmed up before use. Park-Miller
 * seeded with small sequential integers yields a near-zero first output for
 * every seed, which collapsed this corpus to one branch: 299 of 300 seeds
 * generated the same shape. `corpusCoverage` below guards against that
 * regressing.
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
 * Random non-negative integer below `bound`.
 *
 * @param rng - The random source.
 * @param bound - Exclusive upper bound.
 * @returns The integer.
 */
function randomInt(rng: () => number, bound: number): number {
  return Math.floor(rng() * bound);
}

/**
 * Strings chosen to attack the display: dialog-structure forgery, direction
 * and visibility tricks, quoting confusion, and size.
 */
const HOSTILE_TEXT = [
  '',
  'transfer',
  'a'.repeat(300),
  'two\nlines',
  'tab\tseparated',
  '‮gnp.txt', // right-to-left override
  '​zero​width',
  '⁦isolate⁩',
  '﻿byte-order-mark',
  '**bold**',
  '# heading',
  '`code`',
  'Amount: 1000 XLM', // imitates a real dialog row
  'To: GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6',
  '"quoted"',
  "'single'",
  'back\\slash',
  '🙂emoji',
  'ünïcödé',
  '../../etc/passwd',
] as const;

/** Nodes one generated value may contain, so the corpus stays finite. */
const GENERATION_BUDGET = 250;

/** Generation depth cap. The renderer's own cap is exercised separately. */
const GENERATION_DEPTH = 5;

/**
 * Builds a random ScVal, recursing for container variants.
 *
 * Bounded by a shared node budget as well as depth: nested containers
 * multiply, and an unbudgeted walk builds values far larger than anything
 * the 256 KB XDR cap could actually deliver.
 *
 * @param rng - The random source.
 * @param depth - Current nesting depth (bounds generation, not rendering).
 * @param budget - Shared remaining-node counter.
 * @returns An ScVal.
 */
function randomScVal(
  rng: () => number,
  depth = 0,
  budget = { nodes: GENERATION_BUDGET },
): xdr.ScVal {
  budget.nodes -= 1;
  const leafOnly = depth >= GENERATION_DEPTH || budget.nodes <= 0;
  const kinds = leafOnly
    ? ['bool', 'void', 'u32', 'i32', 'u64', 'i64', 'bytes', 'string', 'symbol']
    : [
        'bool',
        'void',
        'u32',
        'i32',
        'u64',
        'i64',
        'timepoint',
        'duration',
        'u128',
        'i128',
        'u256',
        'i256',
        'bytes',
        'string',
        'symbol',
        'address',
        'vec',
        'map',
        'ledgerKeyContractInstance',
        'error',
      ];

  switch (pick(rng, kinds)) {
    case 'bool':
      return xdr.ScVal.scvBool(rng() < 0.5);
    case 'void':
      return xdr.ScVal.scvVoid();
    case 'u32':
      return xdr.ScVal.scvU32(randomInt(rng, 0xffffffff));
    case 'i32':
      return xdr.ScVal.scvI32(randomInt(rng, 0xffffffff) - 0x7fffffff);
    case 'u64':
      return nativeToScVal(BigInt(randomInt(rng, 1e9)), { type: 'u64' });
    case 'i64':
      return nativeToScVal(BigInt(randomInt(rng, 1e9) - 5e8), { type: 'i64' });
    case 'timepoint':
      return nativeToScVal(BigInt(randomInt(rng, 1e9)), { type: 'timepoint' });
    case 'duration':
      return nativeToScVal(BigInt(randomInt(rng, 1e9)), { type: 'duration' });
    case 'u128':
      return nativeToScVal(BigInt(randomInt(rng, 1e9)) * 10n ** 20n, {
        type: 'u128',
      });
    case 'i128':
      return nativeToScVal(-BigInt(randomInt(rng, 1e9)) * 10n ** 20n, {
        type: 'i128',
      });
    case 'u256':
      return nativeToScVal(BigInt(randomInt(rng, 1e9)) * 10n ** 60n, {
        type: 'u256',
      });
    case 'i256':
      return nativeToScVal(-BigInt(randomInt(rng, 1e9)) * 10n ** 60n, {
        type: 'i256',
      });
    case 'bytes':
      // Straddles MAX_SCVAL_BYTES so the truncation marker is exercised.
      return xdr.ScVal.scvBytes(
        Buffer.alloc(
          pick(rng, [0, 1, 63, 64, 65, 200, 4096]),
          randomInt(rng, 256),
        ),
      );
    case 'string':
      return xdr.ScVal.scvString(pick(rng, HOSTILE_TEXT));
    case 'symbol':
      // SCSymbol is capped at 32 bytes on the wire.
      return xdr.ScVal.scvSymbol(pick(rng, HOSTILE_TEXT).slice(0, 32));
    case 'address':
      return new Address(pick(rng, [ACCOUNT, CONTRACT])).toScVal();
    case 'vec': {
      // Straddles MAX_SCVAL_ITEMS so the "+N more" marker is exercised.
      const count = pick(rng, [0, 1, 19, 20, 21, 25]);
      return xdr.ScVal.scvVec(
        Array.from({ length: count }, () =>
          randomScVal(rng, depth + 1, budget),
        ),
      );
    }
    case 'map': {
      const count = pick(rng, [0, 1, 19, 20, 21, 25]);
      return xdr.ScVal.scvMap(
        Array.from(
          { length: count },
          () =>
            new xdr.ScMapEntry({
              key: randomScVal(rng, depth + 1, budget),
              val: randomScVal(rng, depth + 1, budget),
            }),
        ),
      );
    }
    case 'ledgerKeyContractInstance':
      return xdr.ScVal.scvLedgerKeyContractInstance();
    case 'error':
      return xdr.ScVal.scvError(xdr.ScError.sceContract(randomInt(rng, 1000)));
    default:
      return xdr.ScVal.scvVoid();
  }
}

/** Markers the renderer emits when it drops content from the display. */
const TRUNCATION_MARKERS = ['…(too deep)', '…+', 'unsupported('];

/** A property failure, reported with the seed that produced it. */
type Violation = { seed: number; property: string; detail: string };

/**
 * Walks the ScVal corpus and returns every invariant violation found.
 *
 * @returns The violations (empty when all invariants hold).
 */
function scValViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < CASES; seed++) {
    const value = randomScVal(makeRng(seed));
    const flags = { truncated: false };

    let rendered: string;
    try {
      // 1. Never throws: the renderer has a raw-XDR fallback for values it
      //    cannot render, so no input should escape as an exception.
      rendered = formatScVal(value, 0, flags);
    } catch (error) {
      found.push({
        seed,
        property: 'never throws',
        detail: String(error),
      });
      continue;
    }

    // 2. Never emits hidden characters: controls, bidi overrides, and
    //    zero-width marks must be escaped or hex-encoded, never passed
    //    through, or the dialog can be made to read differently from what is
    //    signed.
    if (containsHiddenCharacters(rendered)) {
      found.push({
        seed,
        property: 'no hidden characters',
        detail: JSON.stringify(rendered.slice(0, 120)),
      });
    }

    // 3. Fails closed: the marker in the text and the flag the signing paths
    //    read must never disagree. A marker without the flag is content
    //    dropped from the display that signing would still approve.
    const marked = TRUNCATION_MARKERS.some((marker) =>
      rendered.includes(marker),
    );
    if (marked && !flags.truncated) {
      found.push({
        seed,
        property: 'truncation is flagged',
        detail: rendered.slice(0, 120),
      });
    }

    // Every ScVal arm in the current protocol is handled, so nothing in the
    // corpus may reach the unknown-variant fallback.
    if (rendered.includes('unsupported(')) {
      found.push({
        seed,
        property: 'no known variant is unsupported',
        detail: rendered.slice(0, 120),
      });
    }
  }
  return found;
}

/**
 * Measures what the corpus actually exercises.
 *
 * A property test is only worth its assertions if the corpus reaches the
 * interesting branches. An earlier seeding bug here collapsed 299 of 300
 * cases onto one ScVal variant, leaving the invariants technically passing
 * while checking almost nothing, so the shape of the corpus is now asserted
 * rather than assumed.
 *
 * @returns Counts of the branches that matter.
 */
function corpusCoverage(): {
  kinds: number;
  truncated: number;
  escaped: number;
  containers: number;
} {
  const kinds = new Set<string>();
  let truncated = 0;
  let escaped = 0;
  let containers = 0;
  for (let seed = 0; seed < CASES; seed++) {
    const value = randomScVal(makeRng(seed));
    const flags = { truncated: false };
    const rendered = formatScVal(value, 0, flags);
    kinds.add(value.switch().name);
    if (flags.truncated) {
      truncated += 1;
    }
    // A backslash escape only appears when the input carried a character
    // that had to be neutralised.
    if (rendered.includes('\\')) {
      escaped += 1;
    }
    if (rendered.includes('[') || rendered.includes('{')) {
      containers += 1;
    }
  }
  return { kinds: kinds.size, truncated, escaped, containers };
}

describe('corpus coverage', () => {
  it('reaches the branches the invariants are meant to test', () => {
    const coverage = corpusCoverage();
    // Most of the generator's variants should appear at the top level.
    expect(coverage.kinds).toBeGreaterThan(12);
    // Truncation, escaping, and nesting each have to be exercised, or the
    // corresponding invariant is vacuous.
    expect(coverage.truncated).toBeGreaterThan(10);
    expect(coverage.escaped).toBeGreaterThan(10);
    expect(coverage.containers).toBeGreaterThan(10);
  });
});

describe('formatScVal properties', () => {
  it('holds all three invariants across the generated corpus', () => {
    expect(scValViolations()).toStrictEqual([]);
  });

  it('bounds the rendering of a deeply nested value', () => {
    // A vec nested far past MAX_SCVAL_DEPTH must stop at the cap and say so,
    // rather than recursing to exhaustion.
    let value = xdr.ScVal.scvU32(1);
    for (let level = 0; level < 400; level++) {
      value = xdr.ScVal.scvVec([value]);
    }
    const flags = { truncated: false };
    const rendered = formatScVal(value, 0, flags);
    expect(rendered).toContain('…(too deep)');
    expect(flags.truncated).toBe(true);
    expect(rendered.length).toBeLessThan(200);
  });

  it('bounds the rendering of a very wide value', () => {
    const wide = xdr.ScVal.scvVec(
      Array.from({ length: 5000 }, (_, index) => xdr.ScVal.scvU32(index)),
    );
    const flags = { truncated: false };
    const rendered = formatScVal(wide, 0, flags);
    expect(rendered).toContain('…+4980 more');
    expect(flags.truncated).toBe(true);
  });

  it('fails closed on a variant it does not know', () => {
    // The `default` arm is unreachable with today's XDR, so simulate the
    // future variant it exists for: every known arm is handled, and anything
    // else must be labelled unsupported AND flagged, never rendered as if
    // understood.
    const future = {
      switch: () => ({ name: 'scvSomeFutureVariant' }),
    } as unknown as xdr.ScVal;
    const flags = { truncated: false };
    const rendered = formatScVal(future, 0, flags);
    expect(rendered).toBe('unsupported(scvSomeFutureVariant)');
    expect(flags.truncated).toBe(true);
  });

  it('renders different types to different text', () => {
    // Typed notation exists so a string cannot imitate a number or an
    // address. Same payload, different types, must not collide.
    const payload = '123';
    const renderings = [
      formatScVal(xdr.ScVal.scvString(payload)),
      formatScVal(xdr.ScVal.scvSymbol(payload)),
      formatScVal(xdr.ScVal.scvU32(123)),
      formatScVal(nativeToScVal(123n, { type: 'u64' })),
      formatScVal(nativeToScVal(123n, { type: 'i64' })),
      formatScVal(nativeToScVal(123n, { type: 'timepoint' })),
    ];
    expect(new Set(renderings).size).toBe(renderings.length);
  });
});

/**
 * Collects symbol renderings that leak hidden characters or fail to quote a
 * non-identifier.
 *
 * @returns The violations (empty when all inputs render safely).
 */
function symbolViolations(): Violation[] {
  const found: Violation[] = [];
  for (const [index, text] of HOSTILE_TEXT.entries()) {
    const rendered = formatSymbolName(text);
    if (containsHiddenCharacters(rendered)) {
      found.push({ seed: index, property: 'no hidden', detail: rendered });
    }
    const isIdentifier = /^[A-Za-z0-9_]+$/u.test(text);
    if (!isIdentifier && !rendered.startsWith('"')) {
      found.push({ seed: index, property: 'quoted', detail: rendered });
    }
  }
  return found;
}

describe('formatSymbolName properties', () => {
  it('escapes and quotes anything that is not a plain identifier', () => {
    expect(symbolViolations()).toStrictEqual([]);
  });
});

/**
 * Builds an invocation node with the given sub-invocations and random args.
 *
 * @param rng - The random source.
 * @param subInvocations - Nested nodes.
 * @returns The invocation node.
 */
function randomInvocation(
  rng: () => number,
  subInvocations: xdr.SorobanAuthorizedInvocation[] = [],
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function:
      xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(CONTRACT).toScAddress(),
          functionName: pick(rng, HOSTILE_TEXT).slice(0, 32),
          args: Array.from({ length: randomInt(rng, 4) }, () =>
            randomScVal(rng, 8),
          ),
        }),
      ),
    subInvocations,
  });
}

/**
 * Builds an address-credential auth entry around a root invocation.
 *
 * @param root - The root invocation.
 * @returns The auth entry.
 */
function addressEntry(
  root: xdr.SorobanAuthorizedInvocation,
): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 1000,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: root,
  });
}

/**
 * Walks the auth-entry corpus and returns every invariant violation found.
 *
 * A throw is acceptable here (the caller converts it to a SEP-43 error), but
 * a thrown non-Error, an unbounded result, or hidden characters in the
 * rendered invocation lines are not.
 *
 * @returns The violations (empty when all invariants hold).
 */
function authEntryViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < CASES; seed++) {
    const rng = makeRng(seed);
    const depth = randomInt(rng, 6);
    let node = randomInvocation(rng);
    for (let level = 0; level < depth; level++) {
      node = randomInvocation(rng, [node, randomInvocation(rng)]);
    }

    let decoded;
    try {
      decoded = decodeAuthEntry(addressEntry(node));
    } catch (error) {
      if (!(error instanceof Error)) {
        found.push({
          seed,
          property: 'throws only Errors',
          detail: String(error),
        });
      }
      continue;
    }

    if (
      decoded.invocations.length >
      MAX_INVOCATION_NODES + MAX_INVOCATION_DEPTH + 1
    ) {
      found.push({
        seed,
        property: 'invocation list is bounded',
        detail: String(decoded.invocations.length),
      });
    }
    const dirty = decoded.invocations.find((line) =>
      containsHiddenCharacters(line),
    );
    if (dirty !== undefined) {
      found.push({
        seed,
        property: 'no hidden characters',
        detail: JSON.stringify(dirty.slice(0, 120)),
      });
    }
  }
  return found;
}

/**
 * Exercises the entry summarizer and screener over random entry lists.
 *
 * @returns The violations (empty when both stay total and clean).
 */
function summaryViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < 100; seed++) {
    const rng = makeRng(seed);
    const entries = Array.from({ length: randomInt(rng, 5) }, () =>
      addressEntry(randomInvocation(rng)),
    );
    try {
      const lines = summarizeAuthEntries(entries);
      findUndisplayableAuthEntry(entries);
      const dirty = lines.find((line) => containsHiddenCharacters(line));
      if (dirty !== undefined) {
        found.push({
          seed,
          property: 'no hidden characters',
          detail: JSON.stringify(dirty.slice(0, 120)),
        });
      }
    } catch (error) {
      found.push({ seed, property: 'never throws', detail: String(error) });
    }
  }
  return found;
}

describe('decodeAuthEntry properties', () => {
  it('stays total, bounded, and clean across the corpus', () => {
    expect(authEntryViolations()).toStrictEqual([]);
  });

  it('summarizes and screens entries without throwing', () => {
    expect(summaryViolations()).toStrictEqual([]);
  });

  it('flags a tree deeper than the display cap', () => {
    const rng = makeRng(7);
    let node = randomInvocation(rng);
    for (let level = 0; level < MAX_INVOCATION_DEPTH + 5; level++) {
      node = randomInvocation(rng, [node]);
    }
    expect(decodeAuthEntry(addressEntry(node)).truncated).toBe(true);
  });

  it('flags a tree wider than the node budget', () => {
    const rng = makeRng(8);
    const node = randomInvocation(
      rng,
      Array.from({ length: MAX_INVOCATION_NODES + 20 }, () =>
        randomInvocation(rng),
      ),
    );
    const decoded = decodeAuthEntry(addressEntry(node));
    expect(decoded.truncated).toBe(true);
    // The budget bounds nodes, not rendered lines: each frame that runs out
    // mid-loop adds one "… (truncated)" marker on top, and there can be one
    // per ancestor frame. So the display list is bounded by nodes + depth,
    // not by MAX_INVOCATION_NODES alone.
    expect(decoded.invocations.length).toBeLessThanOrEqual(
      MAX_INVOCATION_NODES + MAX_INVOCATION_DEPTH + 1,
    );
    expect(decoded.invocations.length).toBeGreaterThan(MAX_INVOCATION_NODES);
  });
});

/**
 * Walks the host-function corpus and returns every invariant violation.
 *
 * @returns The violations (empty when all invariants hold).
 */
function hostFunctionViolations(): Violation[] {
  const found: Violation[] = [];
  for (let seed = 0; seed < CASES; seed++) {
    const rng = makeRng(seed);
    const argCount = pick(rng, [0, 1, 19, 20, 21, 40]);
    const hostFunction = xdr.HostFunction.hostFunctionTypeInvokeContract(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(CONTRACT).toScAddress(),
        functionName: pick(rng, HOSTILE_TEXT).slice(0, 32),
        args: Array.from({ length: argCount }, () => randomScVal(rng, 9)),
      }),
    );

    try {
      const decoded = decodeHostFunction(hostFunction);
      if (decoded.kind !== 'invoke') {
        found.push({ seed, property: 'kind', detail: decoded.kind });
      }
      // Arguments past the display cap must set the flag the signing paths
      // refuse on, never be dropped quietly.
      if (argCount > 20 && !decoded.truncated) {
        found.push({
          seed,
          property: 'dropped arguments are flagged',
          detail: `${argCount} args, truncated=false`,
        });
      }
    } catch (error) {
      found.push({ seed, property: 'never throws', detail: String(error) });
    }
  }
  return found;
}

describe('decodeHostFunction properties', () => {
  it('stays total and flags every dropped argument', () => {
    expect(hostFunctionViolations()).toStrictEqual([]);
  });

  it('reports an unknown host function as unknown rather than guessing', () => {
    const future = {
      switch: () => ({ name: 'hostFunctionTypeSomethingNew' }),
    } as unknown as xdr.HostFunction;
    expect(decodeHostFunction(future).kind).toBe('unknown');
  });
});

/**
 * Feeds random bytes to the auth-entry parser.
 *
 * Most inputs fail to parse, which the handler reports as an invalid entry.
 * The rare buffer that does parse must still decode cleanly or throw an
 * Error, never corrupt the display.
 *
 * @returns The violations, plus how many inputs actually parsed.
 */
function randomBytesViolations(): { found: Violation[]; parsed: number } {
  const found: Violation[] = [];
  let parsed = 0;
  for (let seed = 0; seed < CASES; seed++) {
    const rng = makeRng(seed);
    const bytes = Buffer.from(
      Array.from({ length: randomInt(rng, 200) }, () => randomInt(rng, 256)),
    );

    let entry;
    try {
      entry = xdr.SorobanAuthorizationEntry.fromXDR(
        bytes.toString('base64'),
        'base64',
      );
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

    parsed += 1;
    try {
      const dirty = decodeAuthEntry(entry).invocations.find((line) =>
        containsHiddenCharacters(line),
      );
      if (dirty !== undefined) {
        found.push({
          seed,
          property: 'no hidden characters',
          detail: JSON.stringify(dirty.slice(0, 120)),
        });
      }
    } catch (error) {
      if (!(error instanceof Error)) {
        found.push({
          seed,
          property: 'decode throws only Errors',
          detail: String(error),
        });
      }
    }
  }
  return { found, parsed };
}

describe('malformed XDR', () => {
  it('rejects random bytes as an auth entry without crashing', () => {
    expect(randomBytesViolations().found).toStrictEqual([]);
  });
});
