import type { RequestArguments } from '@metamask/providers';
import { useCallback } from 'react';

import { useMetaMaskContext } from './MetamaskContext';

export type Request = (params: RequestArguments) => Promise<unknown | null>;

/**
 * The longest error message the error box will be asked to render. Provider
 * rejections are arbitrary values, and serializing an unbounded one would
 * let a huge payload flood the page.
 */
const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Normalize an arbitrary rejection value into an `Error`.
 *
 * A provider is not obliged to reject with an `Error`: strings and plain
 * `{ code, message }` objects occur in practice, and storing those directly
 * renders `error.message` as "undefined" in the error box.
 *
 * @param value - Whatever the provider rejected with.
 * @returns An `Error` with a bounded, human-readable message.
 */
const normalizeError = (value: unknown): Error => {
  if (value instanceof Error) {
    return value;
  }

  let message: string;
  if (typeof value === 'string') {
    message = value;
  } else if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    message = (value as { message: string }).message;
  } else {
    try {
      message = JSON.stringify(value) ?? String(value);
    } catch {
      // Circular or otherwise unserializable value.
      message = String(value);
    }
  }

  if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
  }

  return new Error(message === '' ? 'Unknown error.' : message);
};

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
        const data =
          (await provider?.request({
            method,
            params,
          } as RequestArguments)) ?? null;

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
