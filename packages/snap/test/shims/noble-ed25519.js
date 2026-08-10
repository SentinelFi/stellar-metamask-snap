/**
 * Test-only CJS shim for the ESM-only `@noble/ed25519`, backed by
 * node:crypto's native ed25519. Implements exactly the surface used by the
 * stellar-sdk signing module: `hashes` (mutable), sync `getPublicKey`,
 * `sign`, and `verify`. Mapped via `moduleNameMapper` in jest.config.js —
 * the snap bundle itself uses the real noble implementation.
 */
const { createPrivateKey, createPublicKey, sign, verify } = require('crypto');

/** DER prefix for a PKCS8-wrapped raw ed25519 private key (seed). */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
/** DER prefix for an SPKI-wrapped raw ed25519 public key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Builds a node KeyObject from a raw 32-byte ed25519 seed.
 *
 * @param {Uint8Array} seed - The raw private seed.
 * @returns {import('crypto').KeyObject} The private key object.
 */
const privateKeyFromSeed = (seed) =>
  createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]),
    format: 'der',
    type: 'pkcs8',
  });

module.exports = {
  // signing.js assigns `hashes.sha512` at load time.
  hashes: {},

  /**
   * Derives the raw 32-byte public key for a seed.
   *
   * @param {Uint8Array} seed - The raw private seed.
   * @returns {Uint8Array} The raw public key.
   */
  getPublicKey(seed) {
    const publicKey = createPublicKey(privateKeyFromSeed(seed));
    const jwk = publicKey.export({ format: 'jwk' });
    return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
  },

  /**
   * Signs a message with a raw seed.
   *
   * @param {Uint8Array} message - The message bytes.
   * @param {Uint8Array} seed - The raw private seed.
   * @returns {Uint8Array} The 64-byte signature.
   */
  sign(message, seed) {
    return new Uint8Array(
      sign(null, Buffer.from(message), privateKeyFromSeed(seed)),
    );
  },

  /**
   * Verifies a signature.
   *
   * @param {Uint8Array} signature - The 64-byte signature.
   * @param {Uint8Array} message - The message bytes.
   * @param {Uint8Array} publicKey - The raw 32-byte public key.
   * @returns {boolean} Whether the signature is valid.
   */
  verify(signature, message, publicKey) {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKey)]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message), key, Buffer.from(signature));
  },
};
