import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source-inspection regression guards for the Round-1 UI overhaul
 * (fixed-viewport table grid, enlarged local-rack tiles, CenterScoreboard
 * dual-render). There is no React DOM testing harness in this repo (no
 * @testing-library/react / jsdom dependency — see package.json), so these
 * guards follow the same "read the component source and assert on it"
 * pattern already established by src/lib/theme/theme-guard.test.ts, rather
 * than introducing a new test-infra dependency for a presentation-only
 * round.
 */

const COMPONENTS_DIR = resolve(__dirname, '../../components/table');

function readComponent(name: string): string {
  return readFileSync(resolve(COMPONENTS_DIR, name), 'utf-8');
}

describe('player-rack.tsx — RACK_TILE_CLASS breakpoint proportionality', () => {
  it('every breakpoint is an exact integer/half-integer multiple of the tile-sprites.ts source art aspect ratio (44x60)', () => {
    const spritesSource = readFileSync(resolve(__dirname, 'tile-sprites.ts'), 'utf-8');
    const artW = Number(/const ART_W = (\d+);/.exec(spritesSource)?.[1]);
    const artH = Number(/const ART_H = (\d+);/.exec(spritesSource)?.[1]);
    expect(artW, 'ART_W constant not found in tile-sprites.ts — source shape changed').toBeGreaterThan(0);
    expect(artH, 'ART_H constant not found in tile-sprites.ts — source shape changed').toBeGreaterThan(0);

    const rackSource = readComponent('player-rack.tsx');
    const classMatch = /const RACK_TILE_CLASS = '([^']+)';/.exec(rackSource);
    expect(classMatch, 'RACK_TILE_CLASS constant not found in player-rack.tsx — source shape changed').not.toBeNull();
    const rackClass = classMatch![1];

    // Extract every {breakpoint}:h-[Npx] / {breakpoint}:w-[Npx] pair.
    const heights = new Map<string, number>();
    const widths = new Map<string, number>();
    for (const m of rackClass.matchAll(/(\w+):h-\[(\d+)px\]/g)) heights.set(m[1], Number(m[2]));
    for (const m of rackClass.matchAll(/(\w+):w-\[(\d+)px\]/g)) widths.set(m[1], Number(m[2]));

    expect(heights.size, `expected at least one breakpoint in "${rackClass}"`).toBeGreaterThan(0);
    expect([...heights.keys()].sort()).toEqual([...widths.keys()].sort());

    const baseRatio = artH / artW;
    for (const [breakpoint, h] of heights) {
      const w = widths.get(breakpoint)!;
      // Every breakpoint's own w/h pair must individually be an exact
      // (possibly non-integer, e.g. 1.5x) multiple of the base art size —
      // i.e. h/w must equal the source art's aspect ratio exactly, not just
      // approximately (a rounding-drifted breakpoint would render tiles
      // with visible aspect distortion).
      expect(h / w, `${breakpoint}: h=${h} w=${w}`).toBeCloseTo(baseRatio, 10);

      // And each must be a clean multiple of the base dimensions (so no
      // breakpoint sits at a fractional pixel that would blur/distort the
      // pixel-art sprite — see CLAUDE.md's "pixel tile art with
      // image-rendering: pixelated" requirement).
      const scale = w / artW;
      expect(Number.isInteger(scale * 2), `${breakpoint}: scale=${scale} is not a multiple of 0.5`).toBe(true);
    }
  });
});

describe('game-table.tsx — CenterScoreboard dual-render mutual exclusivity', () => {
  it('renders <CenterScoreboard exactly twice, once under the desktop `hidden ... md:grid` section and once under the mobile `... md:hidden` section', () => {
    const source = readComponent('game-table.tsx');
    const occurrences = source.match(/<CenterScoreboard/g) ?? [];
    expect(occurrences.length, 'expected exactly one desktop-path and one mobile-path CenterScoreboard render').toBe(2);

    // Anchor on the two section-boundary comments already present in
    // game-table.tsx (desktop 4-seat cross layout vs. mobile stacked
    // layout) rather than nearest-enclosing-className regex parsing, which
    // is unreliable across nested divs (CenterScoreboard sits two levels
    // deep inside the desktop wrapper). If either literal marker below is
    // ever renamed, this test fails loudly rather than silently parsing the
    // wrong section.
    const desktopMarker = 'Tablet+: classic 4-seat cross layout';
    const mobileMarker = 'Mobile: stacked vertical layout';
    const desktopMarkerIndex = source.indexOf(desktopMarker);
    const mobileMarkerIndex = source.indexOf(mobileMarker);
    expect(desktopMarkerIndex, 'desktop section marker comment not found').toBeGreaterThan(-1);
    expect(mobileMarkerIndex, 'mobile section marker comment not found').toBeGreaterThan(-1);
    expect(desktopMarkerIndex).toBeLessThan(mobileMarkerIndex);

    const desktopSection = source.slice(desktopMarkerIndex, mobileMarkerIndex);
    const mobileSection = source.slice(mobileMarkerIndex);

    expect(desktopSection.match(/<CenterScoreboard/g)?.length, 'expected exactly 1 CenterScoreboard in the desktop section').toBe(1);
    expect(mobileSection.match(/<CenterScoreboard/g)?.length, 'expected exactly 1 CenterScoreboard in the mobile section').toBe(1);

    // Desktop section's outermost wrapper (the first className encountered
    // after the marker comment) must be `hidden` by default, `md:grid` at
    // the breakpoint.
    const desktopWrapperClassName = /className="([^"]*)"/.exec(desktopSection)?.[1] ?? '';
    expect(desktopWrapperClassName).toContain('hidden');
    expect(desktopWrapperClassName).toContain('md:grid');

    // Mobile section's outermost wrapper must be the exact inverse: visible
    // by default (no bare `hidden` token), `md:hidden` at the breakpoint.
    const mobileWrapperClassName = /className="([^"]*)"/.exec(mobileSection)?.[1] ?? '';
    expect(mobileWrapperClassName).toContain('md:hidden');
    expect(/(^|\s)hidden(\s|$)/.test(mobileWrapperClassName)).toBe(false);
  });
});
