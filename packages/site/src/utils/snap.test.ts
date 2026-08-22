/* eslint-disable no-restricted-globals, n/no-process-env */
// Runs under Node: the module under test reads its configuration from the
// process environment at import time, so each case sets it and reloads.
import { describe, expect, it, jest } from '@jest/globals';

const VERSION = '0.1.0';
const NPM_ORIGIN = 'npm:stellar-soroban-snap';

/**
 * Loads `./snap` against a given build configuration. The module reads the
 * configuration at import time, so each case gets a fresh module registry.
 *
 * @param origin - The configured snap origin.
 * @param version - The configured snap version, or undefined for none.
 * @returns The module's exports.
 */
async function load(origin: string, version: string | undefined) {
  jest.resetModules();
  process.env.GATSBY_SNAP_ORIGIN = origin;
  if (version === undefined) {
    delete process.env.GATSBY_SNAP_VERSION;
  } else {
    process.env.GATSBY_SNAP_VERSION = version;
  }
  return import('./snap');
}

/**
 * A `wallet_getSnaps` entry as MetaMask reports it.
 *
 * @param id - The reported snap ID.
 * @param version - The reported version.
 * @returns The entry.
 */
function entry(id: string, version: string) {
  return {
    id,
    version,
    permissionName: `wallet_snap_${id}`,
    initialPermissions: {},
  };
}

describe('isExpectedSnapVersion', () => {
  it('accepts exactly the version the site was built for', async () => {
    const { isExpectedSnapVersion } = await load(NPM_ORIGIN, VERSION);
    expect(isExpectedSnapVersion(entry(NPM_ORIGIN, VERSION))).toBe(true);
    expect(isExpectedSnapVersion(entry(NPM_ORIGIN, '0.0.9'))).toBe(false);
    expect(isExpectedSnapVersion(entry(NPM_ORIGIN, '0.2.0'))).toBe(false);
  });

  it('judges the configured origin, not the id inside the entry', async () => {
    // The entry is provider-reported and was read under the configured key
    // anyway; an `id` claiming to be a local development snap must not widen
    // the exemption for a release build.
    const { isExpectedSnapVersion } = await load(NPM_ORIGIN, VERSION);
    expect(
      isExpectedSnapVersion(entry('local:http://localhost:8080', '0.0.9')),
    ).toBe(false);
  });

  it('exempts a local development build and an unpinned one', async () => {
    const local = await load('local:http://localhost:8080', undefined);
    expect(
      local.isExpectedSnapVersion(entry('local:http://localhost:8080', 'x')),
    ).toBe(true);
    const unpinned = await load(NPM_ORIGIN, undefined);
    expect(unpinned.isExpectedSnapVersion(entry(NPM_ORIGIN, '0.0.9'))).toBe(
      true,
    );
  });
});

describe('isSnapEntry', () => {
  it('accepts an entry with a bounded version string', async () => {
    const { isSnapEntry } = await load(NPM_ORIGIN, VERSION);
    expect(isSnapEntry(entry(NPM_ORIGIN, VERSION))).toBe(true);
    expect(isSnapEntry({ version: '1.0.0' })).toBe(true);
  });

  it('refuses entries whose version is missing, not a string, or unbounded', async () => {
    const { isSnapEntry } = await load(NPM_ORIGIN, VERSION);
    expect(isSnapEntry(null)).toBe(false);
    expect(isSnapEntry('0.1.0')).toBe(false);
    expect(isSnapEntry({})).toBe(false);
    expect(isSnapEntry({ version: 1 })).toBe(false);
    expect(isSnapEntry({ version: '' })).toBe(false);
    expect(isSnapEntry({ version: 'v'.repeat(33) })).toBe(false);
  });
});
