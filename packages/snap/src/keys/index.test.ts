import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { SLIP10Node } from '@metamask/key-tree';
import { Keypair } from '@stellar/stellar-sdk';

import {
  getOwnedAccounts,
  resetAddressCache,
  resolveSigningKeypair,
  wipeKeypair,
} from '.';

/** Official SEP-0005 test vector 1 (no passphrase). */
const SEP5_MNEMONIC =
  'illness spike retreat truth genius clock brain pass fit cave bargain toe';
const SEP5_ADDRESS_0 =
  'GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6';
const SEP5_ADDRESS_1 =
  'GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX';
const SEP5_ADDRESS_2 =
  'GAY5PRAHJ2HIYBYCLZXTHID6SPVELOOYH2LBPH3LD4RUMXUW3DOYTLXW';

/**
 * A well-formed address this wallet does not hold, derived here from a fixed
 * synthetic seed rather than hardcoded: the value is self-evidently a test
 * artifact and cannot collide with a real account someone controls.
 */
const FOREIGN_ADDRESS = Keypair.fromRawEd25519Seed(
  Buffer.alloc(32, 7),
).publicKey();

describe('key derivation', () => {
  let stored: unknown;
  let entropyRequests: number;

  beforeEach(async () => {
    const entropy = await SLIP10Node.fromDerivationPath({
      derivationPath: [`bip39:${SEP5_MNEMONIC}`, `slip10:44'`, `slip10:148'`],
      curve: 'ed25519',
    });
    resetAddressCache();
    entropyRequests = 0;
    stored = {
      version: 2,
      network: 'TESTNET',
      activeAccount: 0,
      accounts: [0, 1, 2],
      origins: {},
      tokens: {},
    };
    (globalThis as { snap?: unknown }).snap = {
      request: async (args: {
        method: string;
        params: { operation?: string; newState?: unknown };
      }) => {
        await Promise.resolve();
        switch (args.method) {
          case 'snap_manageState':
            if (args.params.operation === 'get') {
              return stored;
            }
            stored = args.params.newState;
            return null;
          case 'snap_getBip32Entropy':
            entropyRequests += 1;
            return entropy.toJSON();
          default:
            throw new Error(`Unexpected method: ${args.method}`);
        }
      },
    };
  });

  afterEach(() => {
    delete (globalThis as { snap?: unknown }).snap;
  });

  describe('derived keys survive the seed being wiped', () => {
    it('still signs after deriveFromNode zeroes its seed copy', async () => {
      // `deriveFromNode` clears the Buffer it hands to
      // `Keypair.fromRawEd25519Seed`, so one fewer copy of the account secret
      // is left reachable than the function creates. That is only safe while
      // the SDK copies the seed rather than retaining the buffer. If a future
      // version starts retaining it, every signature would be produced from
      // 32 zero bytes: the address would be wrong and this assertion fails,
      // instead of the wipe being quietly removed or, worse, kept while
      // signing breaks somewhere far from here.
      const { keypair } = await resolveSigningKeypair(SEP5_ADDRESS_1);
      expect(keypair.publicKey()).toBe(SEP5_ADDRESS_1);
      const message = Buffer.from('seed-wipe canary', 'utf8');
      expect(keypair.verify(message, keypair.sign(message))).toBe(true);
      // The all-zero seed is what a retained-and-wiped buffer would produce.
      expect(keypair.publicKey()).not.toBe(
        Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0)).publicKey(),
      );
    });
  });

  describe('resolveSigningKeypair', () => {
    it('returns the active account when no address is requested', async () => {
      stored = { ...(stored as object), activeAccount: 2 };
      const { keypair, index } = await resolveSigningKeypair();
      expect(index).toBe(2);
      expect(keypair.publicKey()).toBe(SEP5_ADDRESS_2);
    });

    it('resolves a revealed address to its own index', async () => {
      const { keypair, index } = await resolveSigningKeypair(SEP5_ADDRESS_1);
      expect(index).toBe(1);
      expect(keypair.publicKey()).toBe(SEP5_ADDRESS_1);
    });

    it('refuses an index the user has not revealed', async () => {
      // Index 2 is derivable from the same phrase; only the registry decides
      // what this wallet will act for.
      stored = { ...(stored as object), accounts: [0, 1] };
      await expect(resolveSigningKeypair(SEP5_ADDRESS_2)).rejects.toThrow(
        'Unknown address',
      );
    });

    it('refuses a foreign address', async () => {
      await expect(resolveSigningKeypair(FOREIGN_ADDRESS)).rejects.toThrow(
        'Unknown address',
      );
    });

    it('never treats a non-address as "no selection"', async () => {
      // A fallback to the active account on an unmatched value would sign
      // with a key the caller did not name. Every non-undefined value must
      // fail closed instead. The RPC boundary now strkey-validates the
      // option, so these cannot arrive from a dapp; the primitive is held to
      // the rule anyway, since it is what turns a value into a signature.
      for (const value of ['', ' ', SEP5_ADDRESS_0.toLowerCase(), 'null']) {
        await expect(resolveSigningKeypair(value)).rejects.toThrow(
          'Unknown address',
        );
      }
    });

    it('performs no derivation for a repeated unowned address', async () => {
      // An origin can submit a valid-looking address the wallet does not hold
      // before any dialog or throttle applies. Resolution must not sweep and
      // derive every revealed account each time it does.
      await expect(resolveSigningKeypair(FOREIGN_ADDRESS)).rejects.toThrow(
        'Unknown address',
      );
      const afterFirst = entropyRequests;

      for (let attempt = 0; attempt < 20; attempt++) {
        await expect(resolveSigningKeypair(FOREIGN_ADDRESS)).rejects.toThrow(
          'Unknown address',
        );
      }
      expect(entropyRequests).toBe(afterFirst);
    });

    it('derives the entropy node once per resolution', async () => {
      // Each `snap_getBip32Entropy` call crosses the sandbox boundary with
      // the SEP-5 parent node. Resolving an address must not repeat that per
      // candidate index: with 256 revealed accounts, a single unmatched
      // request would otherwise pull the parent node 256 times before any
      // dialog is shown.
      await expect(resolveSigningKeypair(FOREIGN_ADDRESS)).rejects.toThrow(
        'Unknown address',
      );
      expect(entropyRequests).toBe(1);
    });
  });

  describe('getOwnedAccounts', () => {
    it('lists every revealed account in index order', async () => {
      expect(await getOwnedAccounts()).toStrictEqual([
        { index: 0, address: SEP5_ADDRESS_0 },
        { index: 1, address: SEP5_ADDRESS_1 },
        { index: 2, address: SEP5_ADDRESS_2 },
      ]);
    });

    it('derives the entropy node once for the whole set', async () => {
      // Called on every home-page render and by fund/getBalances/getAccounts.
      await getOwnedAccounts();
      expect(entropyRequests).toBe(1);
    });
  });

  describe('wipeKeypair', () => {
    /*
     * The signing handlers wipe a keypair after its final signature, which
     * rests on two properties of the SDK rather than of this codebase. Both
     * are asserted here so an SDK bump that changes either fails on this test
     * rather than by quietly leaving the secret in memory (if `rawSecretKey`
     * started returning a copy) or by breaking every signing path at once (if
     * the public key stopped being precomputed).
     */

    it('zeroes the secret the keypair holds', async () => {
      const { keypair } = await resolveSigningKeypair();
      expect(keypair.rawSecretKey().some((byte) => byte !== 0)).toBe(true);

      wipeKeypair(keypair);

      expect(keypair.rawSecretKey().every((byte) => byte === 0)).toBe(true);
    });

    it('leaves the public key readable afterwards', async () => {
      // The handlers report `signerAddress` from the keypair, and the wipe
      // happens before that value is returned to the dapp.
      const { keypair } = await resolveSigningKeypair();
      wipeKeypair(keypair);

      expect(keypair.publicKey()).toBe(SEP5_ADDRESS_0);
    });

    it('is safe on a keypair with no secret to wipe', () => {
      const publicOnly = Keypair.fromPublicKey(SEP5_ADDRESS_0);

      expect(() => wipeKeypair(publicOnly)).not.toThrow();
    });
  });
});
