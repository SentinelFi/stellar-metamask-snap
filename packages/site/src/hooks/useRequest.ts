import type { RequestArguments } from '@metamask/providers';
import { useCallback } from 'react';

import { useMetaMaskContext } from './MetamaskContext';
import { normalizeError } from '../utils/errors';

export type Request = (params: RequestArguments) => Promise<unknown | null>;

/**
 * Utility hook to consume the provider `request` method with the available provider.
 *
 * @returns The `request` function.
 */
export const useRequest = () => {
  const { provider, setError } = useMetaMaskContext();

  /**
   * `provider.request` wrapper.
   *
   * Memoized on the provider so hooks can list `request` as an effect
   * dependency without the effect re-running on every render.
   *
   * @param params - The request params.
   * @param params.method - The method to call.
   * @param params.params - The method params.
   * @returns The result of the request.
   */
  const request: Request = useCallback(
    async ({ method, params }) => {
      try {
        const data = (await provider?.request({ method, params })) ?? null;

        return data;
      } catch (requestError) {
        setError(normalizeError(requestError));

        return null;
      }
    },
    [provider, setError],
  );

  return request;
};
