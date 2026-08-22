/**
 * The longest error message the error box will be asked to render. Provider
 * rejections are arbitrary values, and serializing an unbounded one would
 * let a huge payload flood the page.
 */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Normalize an arbitrary rejection value into an `Error` with a bounded,
 * human-readable message.
 *
 * A provider is not obliged to reject with an `Error`: strings and plain
 * `{ code, message }` objects occur in practice, and storing those directly
 * renders `error.message` as "undefined" in the error box. `Error` instances
 * take the same bound as everything else: the provider rejects with `Error`
 * subclasses on the common path, and a message is no less page-supplied text
 * for arriving inside one.
 *
 * @param value - Whatever the provider rejected with.
 * @returns An `Error` with a bounded, human-readable message.
 */
export const normalizeError = (value: unknown): Error => {
  let message: string;
  if (value === undefined || value === null) {
    message = '';
  } else if (value instanceof Error) {
    ({ message } = value);
  } else if (typeof value === 'string') {
    message = value;
  } else if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { message?: unknown }).message === 'string'
  ) {
    message = (value as { message: string }).message;
  } else {
    try {
      message = JSON.stringify(value) ?? '';
    } catch {
      // Circular or otherwise unserializable value: there is nothing
      // readable to show, and the generic message below says so.
      message = '';
    }
  }

  if (message.length > MAX_ERROR_MESSAGE_LENGTH) {
    message = `${message.slice(0, MAX_ERROR_MESSAGE_LENGTH)}...`;
  }

  return new Error(message === '' ? 'Unknown error.' : message);
};
