import { describe, expect, it } from 'vitest';
import { isValidRoomCode, normalizeRoomCode } from './room-code';

describe('normalizeRoomCode', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeRoomCode('  ABC234  ')).toBe('ABC234');
  });

  it('uppercases lowercase input', () => {
    expect(normalizeRoomCode('abc234')).toBe('ABC234');
  });

  it('is idempotent on an already-canonical code', () => {
    const canonical = 'ABC234';
    expect(normalizeRoomCode(canonical)).toBe(canonical);
    expect(normalizeRoomCode(normalizeRoomCode(canonical))).toBe(canonical);
  });
});

describe('isValidRoomCode', () => {
  it('accepts a canonical 6-character code drawn from the alphabet', () => {
    expect(isValidRoomCode('ABC234')).toBe(true);
  });

  it('rejects a 5-character code', () => {
    expect(isValidRoomCode('ABC23')).toBe(false);
  });

  it('rejects a 7-character code', () => {
    expect(isValidRoomCode('ABC2345')).toBe(false);
  });

  it.each(['0', 'O', '1', 'I', 'L'])('rejects a code containing the excluded ambiguous character %s', (char) => {
    expect(isValidRoomCode(`A${char}BC23`)).toBe(false);
  });

  it('rejects a non-normalized (lowercase) code', () => {
    expect(isValidRoomCode('abc234')).toBe(false);
  });
});
