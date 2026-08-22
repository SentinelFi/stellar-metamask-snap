import type { GatsbySSR } from 'gatsby';
import { StrictMode } from 'react';

import { App } from './src/App';
import { defaultSnapOrigin, defaultSnapVersion } from './src/config';
import { Root } from './src/Root';

export const wrapRootElement: GatsbySSR['wrapRootElement'] = ({ element }) => (
  <StrictMode>
    <Root>{element}</Root>
  </StrictMode>
);

export const wrapPageElement: GatsbySSR['wrapPageElement'] = ({ element }) => (
  <App>{element}</App>
);

/**
 * Writes the snap identity the client will use into every page's head.
 *
 * These tags are what the post-build release check reads. They are rendered
 * from the same `src/config` module the browser bundle imports, evaluating
 * the same `process.env.GATSBY_*` expressions, so they report the value the
 * page actually resolved rather than a literal that happens to be present.
 * A build in which Gatsby stopped embedding the environment would render
 * the localhost fallback here, and the check would refuse it.
 *
 * @param args - Gatsby's render-body arguments.
 * @param args.setHeadComponents - Adds elements to the document head.
 */
export const onRenderBody: GatsbySSR['onRenderBody'] = ({
  setHeadComponents,
}) => {
  setHeadComponents([
    <meta
      key="stellar-snap-origin"
      name="stellar-snap-origin"
      content={defaultSnapOrigin}
    />,
    <meta
      key="stellar-snap-version"
      name="stellar-snap-version"
      content={defaultSnapVersion ?? ''}
    />,
  ]);
};
