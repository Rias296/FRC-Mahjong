/**
 * FRC terminology skin — a display-name map over canonical mahjong terms.
 *
 * Pure data + functions only, no React/JSX/fetch. Engine, DB, and the wire
 * protocol always use canonical terms (tile, pung, kong, chow, hu, tai,
 * flower); this module is the ONLY place FRC-robotics display strings live.
 * See CLAUDE.md and docs/DESIGN.md's "FRC theming — display layer only".
 */

import type { Seat } from '../../engine/seats';
import type { TileKind } from '../../engine/tiles';

export type ActionKey = 'draw' | 'discard' | 'hu' | 'pung' | 'kong' | 'chow' | 'pass' | 'rob';

export type GameStatusKey = 'waiting-for-players' | 'in-progress' | 'finished';

const ACTION_LABELS: Readonly<Record<ActionKey, string>> = {
  draw: 'Draw',
  discard: 'Discard',
  hu: 'Hu!',
  pung: 'Pung',
  kong: 'Kong',
  chow: 'Chow',
  pass: 'Pass',
  rob: 'Rob Kong',
};

export function actionLabel(key: ActionKey): string {
  return ACTION_LABELS[key];
}

const SEAT_LABELS: Readonly<Record<Seat, string>> = {
  0: 'Station 1 · East',
  1: 'Station 2 · South',
  2: 'Station 3 · West',
  3: 'Station 4 · North',
};

export function seatLabel(seat: Seat): string {
  return SEAT_LABELS[seat];
}

const SEAT_WIND_LABELS: Readonly<Record<Seat, string>> = {
  0: 'East',
  1: 'South',
  2: 'West',
  3: 'North',
};

export function seatWindLabel(seat: Seat): string {
  return SEAT_WIND_LABELS[seat];
}

const PREVAILING_WIND_LABELS: Readonly<Record<'east' | 'south' | 'west' | 'north', string>> = {
  east: 'East',
  south: 'South',
  west: 'West',
  north: 'North',
};

/** Same word list as seatWindLabel, keyed by the wire's PrevailingWind value instead of a seat. */
export function prevailingWindLabel(wind: 'east' | 'south' | 'west' | 'north'): string {
  return PREVAILING_WIND_LABELS[wind];
}

const SUIT_NAMES: Readonly<Record<'wan' | 'tong' | 'tiao', string>> = {
  wan: 'Characters',
  tong: 'Dots',
  tiao: 'Bamboo',
};

const WIND_TILE_LABELS: Readonly<Record<'east' | 'south' | 'west' | 'north', string>> = {
  east: 'East Wind',
  south: 'South Wind',
  west: 'West Wind',
  north: 'North Wind',
};

const DRAGON_LABELS: Readonly<Record<'red' | 'green' | 'white', string>> = {
  red: 'Red Dragon',
  green: 'Green Dragon',
  white: 'White Dragon',
};

const FLOWER_SERIES_LABELS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'Plum',
  2: 'Orchid',
  3: 'Chrysanthemum',
  4: 'Bamboo Flower',
};

const SEASON_SERIES_LABELS: Readonly<Record<1 | 2 | 3 | 4, string>> = {
  1: 'Spring',
  2: 'Summer',
  3: 'Autumn',
  4: 'Winter',
};

export function tileKindLabel(kind: TileKind): string {
  switch (kind.category) {
    case 'suit':
      return `${kind.rank} ${SUIT_NAMES[kind.suit]}`;
    case 'wind':
      return WIND_TILE_LABELS[kind.wind];
    case 'dragon':
      return DRAGON_LABELS[kind.dragon];
    case 'flower':
      return kind.series === 'flower' ? FLOWER_SERIES_LABELS[kind.number] : SEASON_SERIES_LABELS[kind.number];
  }
}

const STATUS_LABELS: Readonly<Record<GameStatusKey, string>> = {
  'waiting-for-players': 'Match Staging',
  'in-progress': 'Match In Progress',
  finished: 'Match Complete',
};

export function statusLabel(status: GameStatusKey): string {
  return STATUS_LABELS[status];
}

export const TAI_UNIT_SHORT = 'RP';
export const TAI_UNIT_LONG = 'Ranking Points';

export function formatTai(tai: number): string {
  return `${tai} ${TAI_UNIT_SHORT}`;
}
