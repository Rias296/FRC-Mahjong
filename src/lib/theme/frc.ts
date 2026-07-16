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
import type { Band, Division, TierBand } from '../ranked/config';

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

/** Ranked-ladder display unit — "RP" is already taken by tai's display label above. */
export const RANK_UNIT_SHORT = 'DP';
export const RANK_UNIT_LONG = 'District Points';

/** Shared ASCII grouped-thousands digit-grouping logic for formatMatchPoints/formatRankPoints — never duplicate this regex. */
function groupThousands(magnitude: number): string {
  return magnitude.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Match-points (point-stick pool total) numeral formatter — ASCII
 * grouped-thousands, e.g. `100,000` / `-5,000`. Safe for the VT323 HUD font
 * (no CJK, no locale-dependent separators).
 *
 * Deliberately distinct from `formatTai`: match points are the pool-scale
 * point-stick total tracked per seat across a match (`ClientPlayerView.matchPoints`,
 * `PaymentLeg.amount`), while tai is a hand-scoring unit displayed elsewhere
 * as "ranking points"/RP via `formatTai`. The two must never be conflated —
 * an earlier bug rendered `PaymentLeg.amount` (match-points scale, e.g. 5000)
 * through `formatTai` (i.e. labelled "RP"), which this formatter's dedicated
 * unit-less numeral output and the caller-supplied "pts" label
 * (`TABLE_STRINGS.pointsUnitLabel`) replace.
 */
export function formatMatchPoints(points: number): string {
  const magnitude = Math.trunc(Math.abs(points));
  const sign = magnitude !== 0 && points < 0 ? '-' : '';
  return `${sign}${groupThousands(magnitude)}`;
}

/**
 * Ranked-ladder RP numeral formatter, displayed to players as "DP" / District
 * Points (see `RANK_UNIT_SHORT`/`RANK_UNIT_LONG` — `rankPoints`/`rpDelta`
 * stay the canonical wire/DB name; "RP" is already `formatTai`'s display
 * label, per docs/RANKED.md and docs/DECISIONS.md's ranked-ladder sign-off).
 * ASCII grouped-thousands via the same `groupThousands` helper as
 * `formatMatchPoints` (never a duplicated regex), with the unit suffix baked
 * in (like `formatTai`, unlike `formatMatchPoints`) since a bare RP delta
 * numeral with no unit would be ambiguous against match-points deltas shown
 * in the same settlement UI.
 */
export function formatRankPoints(points: number): string {
  const magnitude = Math.trunc(Math.abs(points));
  const sign = magnitude !== 0 && points < 0 ? '-' : '';
  return `${sign}${groupThousands(magnitude)} ${RANK_UNIT_SHORT}`;
}

const TIER_BANDS: readonly TierBand[] = ['bronze', 'silver', 'expert', 'platinum', 'gold', 'apex'];

function isTierBand(value: string): value is TierBand {
  return (TIER_BANDS as readonly string[]).includes(value);
}

/**
 * Narrows a wire-supplied tier string into a real `TierBand`.
 * `ProfileMeResponse.tier`/`ClientRankedResultSeat.tier` are typed as plain
 * `string` on the wire (see protocol.ts's own doc comment on why — that file
 * is out of scope for this round, already shipped) rather than the literal
 * `TierBand` union, since protocol.ts deliberately avoids importing
 * `src/lib/ranked/config.ts`'s server-adjacent types. The server is the sole
 * source of truth and always emits one of the 6 known bands, so an
 * unrecognized value here can only mean a client/server version skew;
 * defensively falls back to 'bronze' rather than crashing the UI. The
 * fallback is deliberately noisy (`console.error`), not silent: 'bronze' is a
 * fully plausible-looking rank badge, indistinguishable on screen from a
 * genuine Bronze player, so a player-visible degrade-quietly/log-loudly split
 * is the only way engineering can ever notice a real version-skew bug — a
 * silent fallback here would make the ranked ladder's entire visible surface
 * (the badge) able to lie confidently with zero signal.
 */
export function asTierBand(value: string): TierBand {
  if (isTierBand(value)) return value;
  console.error(`asTierBand: unrecognized tier "${value}" from the wire — falling back to 'bronze'. This indicates a client/server version skew.`);
  return 'bronze';
}

const TIER_BAND_LABELS: Readonly<Record<Band, string>> = {
  bronze: 'Bronze',
  silver: 'Silver',
  expert: 'Expert',
  platinum: 'Platinum',
  gold: 'Gold',
};

/**
 * Full user-facing tier+division label for a ladder rung, e.g. "Bronze 3".
 * Apex Grandmaster has no numbered division, so it renders with no division
 * suffix: "Apex Grandmaster" (per docs/RANKED.md §1/§3). `division` should be
 * non-null for every non-apex tier in practice (see `rankForRp`), but this
 * degrades gracefully (band name alone) rather than crashing if it's ever
 * null for a numbered band.
 */
export function tierLabel(tier: TierBand, division: Division | null): string {
  if (tier === 'apex') return 'Apex Grandmaster';
  return division === null ? TIER_BAND_LABELS[tier] : `${TIER_BAND_LABELS[tier]} ${division}`;
}

/** Just the division part of a rung, e.g. "Division 3". Apex (no numbered division) renders as an empty string. */
export function divisionLabel(division: Division | null): string {
  return division === null ? '' : `Division ${division}`;
}
