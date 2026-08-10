/**
 * Test-only CJS shim for the ESM-only `@noble/hashes/sha2.js`, backed by
 * node:crypto. Jest's runtime cannot load the ESM original, and ts-jest
 * passes node_modules JS through untransformed. Mapped via
 * `moduleNameMapper` in jest.config.js — the snap bundle itself uses the
 * real @noble implementation.
 */
const { createHash } = require('crypto');

/**
 * SHA-256 of the input bytes.
 *
 * @param {Uint8Array} data - Input bytes.
 * @returns {Uint8Array} The 32-byte digest.
 */
const sha256 = (data) =>
  new Uint8Array(createHash('sha256').update(Buffer.from(data)).digest());

/**
 * SHA-512 of the input bytes.
 *
 * @param {Uint8Array} data - Input bytes.
 * @returns {Uint8Array} The 64-byte digest.
 */
const sha512 = (data) =>
  new Uint8Array(createHash('sha512').update(Buffer.from(data)).digest());

module.exports = { sha256, sha512 };
