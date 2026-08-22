const {
  CONFIG_ENV_NAMES,
  ORIGIN_META,
  VERSION_META,
  isPageDocument,
  verifyEmittedIdentity,
} = require('./release-check');

const SNAP_ORIGIN = 'npm:stellar-soroban-snap';
const SNAP_VERSION = '0.1.0';
const LOCAL_SNAP = 'local:http://localhost:8080';

/**
 * A page document the way Gatsby renders the identity meta tags.
 *
 * @param {string} origin - The resolved snap origin.
 * @param {string} version - The resolved snap version.
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
 * The slice fragment Gatsby emits under `_gatsby/slices/`: a bare script
 * block with no document around it, and so no head to render tags into.
 */
const SLICE_FRAGMENT = `
          <script id="gatsby-chunk-mapping">
            window.___chunkMapping="{}";
          </script>
        <script>window.___webpackCompilationHash="abc";</script>
`;

/**
 * A correct client bundle: the configuration values substituted in as
 * literals, with the `??` fallback retained as dead code (which is what the
 * minifier actually leaves behind), and the connector's own constants.
 */
const SUBSTITUTED_BUNDLE = `var o="${SNAP_ORIGIN}"??"${LOCAL_SNAP}",v="${SNAP_VERSION}";`;

/**
 * The artifact of a sound release build.
 *
 * @returns {object} Documents and scripts.
 */
function soundArtifact() {
  return {
    documents: [
      { path: 'index.html', html: page(SNAP_ORIGIN, SNAP_VERSION) },
      { path: '404.html', html: page(SNAP_ORIGIN, SNAP_VERSION) },
      { path: '_gatsby/slices/_gatsby-scripts-1.html', html: SLICE_FRAGMENT },
    ],
    scripts: [{ path: 'app-abc.js', code: SUBSTITUTED_BUNDLE }],
  };
}

const EXPECTED = { snapOrigin: SNAP_ORIGIN, snapVersion: SNAP_VERSION };

describe('verifyEmittedIdentity', () => {
  it('accepts a build whose pages resolve the audited identity', () => {
    expect(verifyEmittedIdentity(soundArtifact(), EXPECTED)).toStrictEqual([]);
  });

  it('ignores slice fragments, which have no head to render tags into', () => {
    // Regression: requiring the tags of every emitted HTML file failed the
    // build on `_gatsby/slices/_gatsby-scripts-1.html`, a script fragment
    // that is stitched into a page rather than served as one.
    const artifact = soundArtifact();
    artifact.documents = [artifact.documents[2]];
    const problems = verifyEmittedIdentity(artifact, EXPECTED);
    // No per-page complaint; the failure is that nothing was checkable.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('No page documents were emitted');
  });

  it('refuses a build that fell back to the development snap', () => {
    // The regression the meta tags exist for: the connector's constants make
    // the quoted literals present in every bundle, so a literal search
    // passed on exactly the build whose configuration resolved to localhost.
    const artifact = soundArtifact();
    artifact.documents[0] = { path: 'index.html', html: page(LOCAL_SNAP, '') };
    const problems = verifyEmittedIdentity(artifact, EXPECTED);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('index.html');
    expect(problems[0]).toContain(LOCAL_SNAP);
  });

  it('refuses a browser bundle that still reads the configuration at runtime', () => {
    // The failure the meta tags cannot see: they are rendered by the server
    // bundle, which reads a populated `process.env` whatever Gatsby did with
    // client code. An unsubstituted browser bundle keeps the variable name.
    for (const name of CONFIG_ENV_NAMES) {
      const artifact = soundArtifact();
      artifact.scripts = [
        {
          path: 'app-abc.js',
          code: `${SUBSTITUTED_BUNDLE}process.env.${name}`,
        },
      ];
      const problems = verifyEmittedIdentity(artifact, EXPECTED);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('app-abc.js');
      expect(problems[0]).toContain(name);
    }
  });

  it('refuses a build whose scripts do not carry the origin at all', () => {
    const artifact = soundArtifact();
    artifact.scripts = [{ path: 'app-abc.js', code: 'var x=1;' }];
    const problems = verifyEmittedIdentity(artifact, EXPECTED);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('cannot be requesting it');
  });

  it('does not complain about the retained development fallback', () => {
    // A correct build keeps the `??` right-hand side as dead code, so
    // flagging it would fire on every good build.
    expect(SUBSTITUTED_BUNDLE).toContain(LOCAL_SNAP);
    expect(verifyEmittedIdentity(soundArtifact(), EXPECTED)).toStrictEqual([]);
  });

  it('names every page that is wrong, and reports pages by path', () => {
    const artifact = soundArtifact();
    artifact.documents[1] = {
      path: '404.html',
      html: page(SNAP_ORIGIN, '0.0.9'),
    };
    const problems = verifyEmittedIdentity(artifact, EXPECTED);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('404.html');
    expect(problems[0]).toContain('0.0.9');
  });

  it('refuses a page with no identity tags at all', () => {
    const artifact = soundArtifact();
    artifact.documents[0] = {
      path: 'index.html',
      html: '<!doctype html><html><head></head><body></body></html>',
    };
    const problems = verifyEmittedIdentity(artifact, EXPECTED);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('no value at all');
  });
});

describe('isPageDocument', () => {
  it('separates documents a visitor loads from fragments', () => {
    expect(isPageDocument(page(SNAP_ORIGIN, SNAP_VERSION))).toBe(true);
    expect(isPageDocument('<HTML><body></body></HTML>')).toBe(true);
    expect(isPageDocument(SLICE_FRAGMENT)).toBe(false);
    expect(isPageDocument('')).toBe(false);
    // A mention of the word in text is not an element.
    expect(isPageDocument('<p>html is a markup language</p>')).toBe(false);
  });
});
