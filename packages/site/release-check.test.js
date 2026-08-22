const {
  LOCAL_SNAP_LITERAL,
  ORIGIN_META,
  VERSION_META,
  hasQuotedLiteral,
  verifyEmittedIdentity,
} = require('./release-check');

const SNAP_ORIGIN = 'npm:stellar-soroban-snap';
const SNAP_VERSION = '0.1.0';

/**
 * A document head the way Gatsby renders the identity meta tags.
 *
 * @param {string} origin - The evaluated snap origin.
 * @param {string} version - The evaluated snap version.
 * @returns {string} The HTML.
 */
function page(origin, version) {
  return (
    `<!doctype html><html><head>` +
    `<meta name="${ORIGIN_META}" content="${origin}"/>` +
    `<meta content="${version}" name="${VERSION_META}"/>` +
    `</head><body></body></html>`
  );
}

/**
 * A bundle that carries the connector's own constants, which every build
 * does whether or not the environment was embedded.
 */
const CONNECTOR_CONSTANTS = `const a="${SNAP_ORIGIN}",b="${SNAP_VERSION}";`;

describe('verifyEmittedIdentity', () => {
  it('accepts a build whose pages evaluate the audited identity', () => {
    const result = verifyEmittedIdentity(
      {
        html: [page(SNAP_ORIGIN, SNAP_VERSION)],
        scripts: [CONNECTOR_CONSTANTS],
      },
      { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION },
    );
    expect(result.problems).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
  });

  it('refuses a build that fell back to the development snap', () => {
    // The regression this exists for: the connector's constants make the
    // quoted literals present in every bundle, so a literal search passed on
    // exactly the build whose client evaluated the localhost fallback.
    const result = verifyEmittedIdentity(
      {
        html: [page(LOCAL_SNAP_LITERAL, '')],
        scripts: [CONNECTOR_CONSTANTS],
      },
      { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION },
    );
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toContain(LOCAL_SNAP_LITERAL);
  });

  it('refuses a build with no identity tags and a build with no pages', () => {
    const untagged = verifyEmittedIdentity(
      { html: ['<html><head></head></html>'], scripts: [CONNECTOR_CONSTANTS] },
      { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION },
    );
    expect(untagged.problems.join('\n')).toContain('missing');

    const empty = verifyEmittedIdentity(
      { html: [], scripts: [CONNECTOR_CONSTANTS] },
      { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION },
    );
    expect(empty.problems.length).toBeGreaterThan(0);
  });

  it('refuses a page that evaluates a different version', () => {
    const result = verifyEmittedIdentity(
      { html: [page(SNAP_ORIGIN, '0.0.9')], scripts: [CONNECTOR_CONSTANTS] },
      { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION },
    );
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('0.0.9');
  });

  it('only warns when the minifier kept the development fallback literal', () => {
    const result = verifyEmittedIdentity(
      {
        html: [page(SNAP_ORIGIN, SNAP_VERSION)],
        scripts: [`${CONNECTOR_CONSTANTS}const c="${LOCAL_SNAP_LITERAL}";`],
      },
      { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION },
    );
    expect(result.problems).toStrictEqual([]);
    expect(result.warnings).toHaveLength(1);
  });
});

describe('hasQuotedLiteral', () => {
  it('matches only complete string literals in either quote style', () => {
    expect(hasQuotedLiteral(['x="1.2.3"'], '1.2.3')).toBe(true);
    expect(hasQuotedLiteral(["x='1.2.3'"], '1.2.3')).toBe(true);
    // A fragment of something else is not the literal.
    expect(hasQuotedLiteral(['x="v1.2.3-beta"'], '1.2.3')).toBe(false);
    expect(hasQuotedLiteral([], '1.2.3')).toBe(false);
  });
});
