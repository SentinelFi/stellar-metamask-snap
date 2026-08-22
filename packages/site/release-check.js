/**
 * Pure checks behind the site's post-build release verification, kept out of
 * `gatsby-node.js` so they can be unit-tested: Gatsby refuses unknown exports
 * from its API file, and a check that cannot be tested is a check whose
 * failure mode nobody has seen.
 */

/** The meta tags `gatsby-ssr.tsx` renders into every page's head. */
const ORIGIN_META = 'stellar-snap-origin';
const VERSION_META = 'stellar-snap-version';

/**
 * The development fallback the client configuration uses when the build did
 * not embed a snap origin. Its presence as a literal in emitted JavaScript
 * is a warning sign on a release build, not proof of a problem: a minifier
 * is free to fold the fallback away or to keep it, so this is advisory and
 * the meta-tag check below is what decides.
 */
const LOCAL_SNAP_LITERAL = 'local:http://localhost:8080';

/**
 * Whether any emitted script contains `value` as a complete string literal
 * (in either quote style the minifier may choose).
 *
 * A bare substring test is near-vacuous for values like a version number:
 * "1.2.3" appears in dependency banners, source URLs, and unrelated
 * constants all over a production bundle. Requiring the quoted form means
 * the value is present as the actual string literal the client code will
 * read at runtime, not as an accidental fragment of something else.
 *
 * @param {string[]} emitted - The emitted script contents.
 * @param {string} value - The exact string the bundle must carry.
 * @returns {boolean} True when some script contains the quoted literal.
 */
function hasQuotedLiteral(emitted, value) {
  const doubleQuoted = JSON.stringify(value);
  const singleQuoted = `'${value}'`;
  return emitted.some(
    (code) => code.includes(doubleQuoted) || code.includes(singleQuoted),
  );
}

/**
 * Reads the `content` of a named meta tag from an HTML document, whatever
 * attribute order the renderer chose.
 *
 * @param {string} html - The document.
 * @param {string} name - The meta `name`.
 * @returns {string | null} The content, or null when the tag is absent.
 */
function metaContent(html, name) {
  const tag = new RegExp(`<meta\\b[^>]*\\bname="${name}"[^>]*>`, 'u').exec(
    html,
  );
  if (!tag) {
    return null;
  }
  const content = /\bcontent="([^"]*)"/u.exec(tag[0]);
  return content ? content[1] : null;
}

/**
 * Verifies that the built site will ask every visitor's wallet for exactly
 * the audited snap identity.
 *
 * The check reads the value the client module actually evaluated, not a
 * literal. `gatsby-ssr.tsx` renders the configured origin and version into
 * meta tags from the same `src/config` module the browser bundle imports,
 * and the same `process.env.GATSBY_*` expression is evaluated for both. A
 * literal search cannot do this job: the connector ships the published snap
 * ID and the release version as its own constants, so the quoted literals
 * are present in every build whether or not the substitution happened, and
 * a check satisfied by them would pass on the very build that fell back to
 * the localhost development snap.
 *
 * @param {object} artifact - The build output.
 * @param {string[]} artifact.html - Every emitted HTML document.
 * @param {string[]} artifact.scripts - Every emitted script.
 * @param {object} expected - The audited identity.
 * @param {string} expected.snapOrigin - The `npm:` snap ID.
 * @param {string} expected.snapVersion - The exact release version.
 * @returns {{ problems: string[], warnings: string[] }} What is wrong, and
 * what merely looks suspicious.
 */
function verifyEmittedIdentity({ html, scripts }, { snapOrigin, snapVersion }) {
  const problems = [];
  const warnings = [];

  if (html.length === 0) {
    problems.push(
      'No HTML documents were emitted, so nothing could be verified.',
    );
  }
  html.forEach((document, index) => {
    const origin = metaContent(document, ORIGIN_META);
    const version = metaContent(document, VERSION_META);
    if (origin !== snapOrigin) {
      problems.push(
        `Document ${index + 1} evaluates the snap origin as ${
          origin === null ? 'missing' : JSON.stringify(origin)
        }, expected ${JSON.stringify(snapOrigin)}.`,
      );
    }
    if (version !== snapVersion) {
      problems.push(
        `Document ${index + 1} evaluates the snap version as ${
          version === null ? 'missing' : JSON.stringify(version)
        }, expected ${JSON.stringify(snapVersion)}.`,
      );
    }
  });

  if (!hasQuotedLiteral(scripts, snapOrigin)) {
    problems.push(
      `No emitted script carries the quoted literal ${JSON.stringify(snapOrigin)}.`,
    );
  }
  if (hasQuotedLiteral(scripts, LOCAL_SNAP_LITERAL)) {
    warnings.push(
      `An emitted script still carries the development fallback ${JSON.stringify(
        LOCAL_SNAP_LITERAL,
      )}. The evaluated identity above is what the page uses; this only means the minifier kept the fallback branch.`,
    );
  }

  return { problems, warnings };
}

module.exports = {
  LOCAL_SNAP_LITERAL,
  ORIGIN_META,
  VERSION_META,
  hasQuotedLiteral,
  metaContent,
  verifyEmittedIdentity,
};
