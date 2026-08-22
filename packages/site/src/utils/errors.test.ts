import { describe, expect, it } from '@jest/globals';

import { MAX_ERROR_MESSAGE_LENGTH, normalizeError } from './errors';

describe('normalizeError', () => {
  it('bounds the message of an Error instance like any other rejection', () => {
    // MetaMask rejects with Error subclasses on the common path; a message
    // is no less page-supplied text for arriving inside one.
    const long = new Error('x'.repeat(MAX_ERROR_MESSAGE_LENGTH * 10));
    const normalized = normalizeError(long);
    expect(normalized).toBeInstanceOf(Error);
    expect(normalized.message).toHaveLength(MAX_ERROR_MESSAGE_LENGTH + 3);
    expect(normalized.message.endsWith('...')).toBe(true);
  });

  it('keeps a short Error message intact', () => {
    expect(normalizeError(new Error('denied')).message).toBe('denied');
  });

  it('normalizes strings, message-bearing objects, and other values', () => {
    expect(normalizeError('plain').message).toBe('plain');
    expect(normalizeError({ code: 4001, message: 'rejected' }).message).toBe(
      'rejected',
    );
    expect(normalizeError({ code: 4001 }).message).toBe('{"code":4001}');
    expect(normalizeError(undefined).message).toBe('Unknown error.');
    expect(normalizeError('').message).toBe('Unknown error.');
  });

  it('survives a value that cannot be serialized', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(normalizeError(circular).message).toBe('Unknown error.');
  });

  it('bounds every shape, not only Error instances', () => {
    const long = 'y'.repeat(MAX_ERROR_MESSAGE_LENGTH * 4);
    expect(normalizeError(long).message).toHaveLength(
      MAX_ERROR_MESSAGE_LENGTH + 3,
    );
    expect(normalizeError({ message: long }).message).toHaveLength(
      MAX_ERROR_MESSAGE_LENGTH + 3,
    );
  });
});
