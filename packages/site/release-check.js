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
 * The environment variables the client configuration reads. Their names must
 * not survive into emitted browser code: see {@link verifyEmittedIdentity}.
 */
const CONFIG_ENV_NAMES = ['GATSBY_SNAP_ORIGIN', 'GATSBY_SNAP_VERSION'];

/**
 * Whether an emitted HTML file is a document a visitor loads, as opposed to a
 * fragment the build stitches into one.
 *
 * Gatsby emits both. Pages (`index.html`, `404.html`, and the per-route
 * documents) are rendered through the SSR pipeline and therefore carry the
 * head components; slice fragments under `_gatsby/slices/` are bare
 * `<script>` blocks with no `<head>` at all, so requiring the identity tags
 * of those would fail every build for a reason that has nothing to do with
 * the snap identity. Presence of an `<html>` element is the distinction, and
 * it is the right one to draw: what the check is really asserting is that
 * every page a visitor can open states the identity it will use.
 *
 * @param {string} html - The file contents.
 * @returns {boolean} True for a full document.
 */
function isPageDocument(html) {
  return /<html[\s>]/iu.test(html);
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
 * Two independent things have to hold, and neither alone is enough.
 *
 * Every emitted page must *state* the identity it resolved. `gatsby-ssr.tsx`
 * renders the configured origin and version into meta tags from the same
 * `src/config` module the browser bundle imports, so the tags report a value
 * the configuration actually evaluated rather than a string that happens to
 * be present somewhere in the output. A literal search cannot do this job:
 * the connector ships the published snap ID and the release version as its
 * own constants, so the quoted literals are in every build whether or not
 * the substitution happened, and a check satisfied by them would pass on the
 * very build that fell back to the localhost development snap.
 *
 * And the browser bundle must have had those values *substituted into it* at
 * build time. The meta tags are rendered by the server bundle, which runs in
 * Node where `process.env` is populated regardless, so they would still read
 * correctly if Gatsby stopped embedding the variables in client code, which
 * is the documented behaviour this whole guard exists to catch. What that
 * failure would leave behind is the variable *name*: unsubstituted code
 * reads `process.env.GATSBY_SNAP_ORIGIN` at runtime, so the identifier
 * survives into the emitted script, whereas a substituted build has replaced
 * the whole expression with a literal and mentions the name nowhere. Its
 * absence is therefore the evidence that the browser resolves the same
 * identity the page advertises.
 *
 * There is deliberately no check on the development fallback literal
 * (`local:http://localhost:8080`). It is the right-hand side of the `??` in
 * the configuration module, so a correct build keeps it as dead code unless
 * the minifier happens to fold the branch away; flagging it would fire on
 * every good build, and a warning that always fires is one nobody reads.
 *
 * @param {object} artifact - The build output.
 * @param {{ path: string, html: string }[]} artifact.documents - Every
 * emitted HTML file, with the path to report it by.
 * @param {{ path: string, code: string }[]} artifact.scripts - Every emitted
 * script, with the path to report it by.
 * @param {object} expected - The audited identity.
 * @param {string} expected.snapOrigin - The `npm:` snap ID.
 * @param {string} expected.snapVersion - The exact release version.
 * @returns {string[]} What is wrong, empty when the artifact is sound.
 */
function verifyEmittedIdentity(
  { documents, scripts },
  { snapOrigin, snapVersion },
) {
  const problems = [];

  const pages = documents.filter((document) => isPageDocument(document.html));
  if (pages.length === 0) {
    problems.push(
      'No page documents were emitted, so no page could be checked. ' +
        `(${documents.length} HTML file(s) were found, none of them a document.)`,
    );
  }
  for (const { path, html } of pages) {
    const origin = metaContent(html, ORIGIN_META);
    const version = metaContent(html, VERSION_META);
    if (origin !== snapOrigin) {
      problems.push(
        `${path} resolves the snap origin to ${
          origin === null ? 'no value at all' : JSON.stringify(origin)
        }, expected ${JSON.stringify(snapOrigin)}.`,
      );
    }
    if (version !== snapVersion) {
      problems.push(
        `${path} resolves the snap version to ${
          version === null ? 'no value at all' : JSON.stringify(version)
        }, expected ${JSON.stringify(snapVersion)}.`,
      );
    }
  }

  const carriesOrigin = scripts.some(({ code }) =>
    code.includes(JSON.stringify(snapOrigin)),
  );
  if (!carriesOrigin) {
    problems.push(
      `No emitted script carries the snap origin ${JSON.stringify(
        snapOrigin,
      )} as a string literal, so the browser bundle cannot be requesting it.`,
    );
  }
  for (const { path, code } of scripts) {
    for (const name of CONFIG_ENV_NAMES) {
      if (code.includes(name)) {
        problems.push(
          `${path} still reads ${name} at runtime, so the build did not ` +
            `substitute it into browser code and the page would fall back ` +
            `to the development snap.`,
        );
      }
    }
  }

  return problems;
}

module.exports = {
  CONFIG_ENV_NAMES,
  ORIGIN_META,
  VERSION_META,
  isPageDocument,
  metaContent,
  verifyEmittedIdentity,
};
