import { describe, expect, it } from 'vitest';
import {
  actionLabel,
  formatTai,
  seatLabel,
  seatWindLabel,
  statusLabel,
  tileKindLabel,
  type ActionKey,
  type GameStatusKey,
} from './frc';
import type { Seat } from '../../engine/seats';
import type { TileKind } from '../../engine/tiles';

describe('actionLabel', () => {
  it('returns a distinct non-empty label for every ActionKey', () => {
    const keys: readonly ActionKey[] = ['draw', 'discard', 'hu', 'pung', 'kong', 'chow', 'pass', 'rob'];
    const labels = keys.map(actionLabel);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
    expect(new Set(labels).size).toBe(keys.length);
  });
});

describe('seatLabel', () => {
  it('maps all four seats to Station 1-4 with correct winds', () => {
    expect(seatLabel(0)).toBe('Station 1 · East');
    expect(seatLabel(1)).toBe('Station 2 · South');
    expect(seatLabel(2)).toBe('Station 3 · West');
    expect(seatLabel(3)).toBe('Station 4 · North');
  });

  it('seatWindLabel maps seats to plain wind names', () => {
    const seats: readonly Seat[] = [0, 1, 2, 3];
    expect(seats.map(seatWindLabel)).toEqual(['East', 'South', 'West', 'North']);
  });
});

describe('tileKindLabel', () => {
  it('names suit tiles as "<rank> <suit>"', () => {
    const tong5: TileKind = { category: 'suit', suit: 'tong', rank: 5 };
    expect(tileKindLabel(tong5)).toBe('5 Dots');
    const wan1: TileKind = { category: 'suit', suit: 'wan', rank: 1 };
    expect(tileKindLabel(wan1)).toBe('1 Characters');
    const tiao9: TileKind = { category: 'suit', suit: 'tiao', rank: 9 };
    expect(tileKindLabel(tiao9)).toBe('9 Bamboo');
  });

  it('names winds, dragons, flowers, and seasons (disambiguating flower vs season)', () => {
    expect(tileKindLabel({ category: 'wind', wind: 'east' })).toBe('East Wind');
    expect(tileKindLabel({ category: 'dragon', dragon: 'red' })).toBe('Red Dragon');
    // Flower series number 4 ("Bamboo Flower") must be distinguishable from the
    // suit name "Bamboo" (tiao) used above.
    expect(tileKindLabel({ category: 'flower', series: 'flower', number: 4 })).toBe('Bamboo Flower');
    expect(tileKindLabel({ category: 'flower', series: 'season', number: 1 })).toBe('Spring');
  });
});

describe('statusLabel', () => {
  it('covers all three game statuses', () => {
    const statuses: readonly GameStatusKey[] = ['waiting-for-players', 'in-progress', 'finished'];
    expect(statuses.map(statusLabel)).toEqual(['Match Staging', 'Match In Progress', 'Match Complete']);
  });
});

describe('formatTai', () => {
  it('renders "<n> RP" and never says "tai"', () => {
    expect(formatTai(3)).toBe('3 RP');
    expect(formatTai(0)).toBe('0 RP');
    expect(formatTai(3).toLowerCase()).not.toContain('tai');
  });
});
