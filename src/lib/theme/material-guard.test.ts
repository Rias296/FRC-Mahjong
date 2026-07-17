import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Source-inspection regression guards for the Phase 2 "material layer"
 * round (wood/gold OrnateFrame primitive adopted by seat panels + the
 * scoreboard). Same "read the component source and assert on it" pattern as
 * src/lib/theme/theme-guard.test.ts and
 * src/lib/table/table-presentation-guards.test.ts — there is no React DOM
 * testing harness in this repo (no @testing-library/react / jsdom
 * dependency, see package.json).
 */

const TABLE_COMPONENTS_DIR = resolve(__dirname, '../../components/table');
const GLOBALS_CSS_PATH = resolve(__dirname, '../../app/globals.css');
const BUTTON_PATH = resolve(__dirname, '../../components/ui/button.tsx');

function readTableComponent(name: string): string {
  return readFileSync(resolve(TABLE_COMPONENTS_DIR, name), 'utf-8');
}

const ORNAMENT_IDENTIFIERS = ['OrnateFrame', 'CornerBracket', 'frame-wood', 'panel-plaque'];

describe('material guard: tile readability stays unornamented', () => {
  const scannedFiles = ['tile-face.tsx', 'discard-pool.tsx'];

  it('scanned at least one file', () => {
    // Sanity check on the scan itself — an empty file list would make every
    // other assertion in this suite vacuously true and silently useless.
    expect(scannedFiles.length).toBeGreaterThan(0);
  });

  it('tile-face.tsx and discard-pool.tsx contain no ornament identifiers', () => {
    for (const file of scannedFiles) {
      const source = readTableComponent(file);
      for (const identifier of ORNAMENT_IDENTIFIERS) {
        expect(source.includes(identifier), `${file} unexpectedly contains "${identifier}"`).toBe(false);
      }
    }
  });
});

describe('material guard: ornate-frame.tsx accessibility', () => {
  it('brackets are aria-hidden and pointer-events-none', () => {
    const source = readTableComponent('ornate-frame.tsx');
    expect(source).toContain('aria-hidden');
    expect(source).toContain('pointer-events-none');
  });
});

describe('material guard: globals.css wood tokens', () => {
  it('defines wood tokens in :root and maps them in @theme inline', () => {
    const source = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    expect(source).toContain('--wood:');
    expect(source).toContain('--wood-dark:');
    expect(source).toContain('--wood-light:');
    expect(source).toContain('--color-wood:');
    expect(source).toContain('--color-wood-dark:');
    expect(source).toContain('--color-wood-light:');
  });
});

describe('material guard: seat panels and scoreboard adopted the frame', () => {
  const adopters = ['opponent-panel.tsx', 'player-rack.tsx', 'center-scoreboard.tsx'];

  it('scanned at least one adopter file', () => {
    expect(adopters.length).toBeGreaterThan(0);
  });

  it('each adopter contains OrnateFrame and no longer contains border-primary-hover/70', () => {
    for (const file of adopters) {
      const source = readTableComponent(file);
      expect(source.includes('OrnateFrame'), `${file} does not contain "OrnateFrame"`).toBe(true);
      expect(source.includes('border-primary-hover/70'), `${file} still contains "border-primary-hover/70"`).toBe(false);
    }
  });
});

describe('material guard: turn highlight preserved', () => {
  it('opponent-panel.tsx still gates ring-frc-blue-text on isCurrentTurn', () => {
    const source = readTableComponent('opponent-panel.tsx');
    expect(source).toContain('ring-frc-blue-text');
    expect(source).toContain('isCurrentTurn');
  });

  it('the ring is genuinely gated by isCurrentTurn — not just two independently-present strings (would pass vacuously otherwise)', () => {
    // The two substring checks above would pass just as well if
    // 'isCurrentTurn' and 'ring-frc-blue-text' appeared anywhere in the file
    // unrelated to each other (e.g. isCurrentTurn used only for something
    // else, ring-frc-blue-text hardcoded unconditionally). Anchor on the
    // actual conditional-expression coupling instead.
    const source = readTableComponent('opponent-panel.tsx');
    expect(source).toMatch(/isCurrentTurn\s*&&\s*'ring-2 ring-frc-blue-text'/);
  });

  it('the ring className lands on OrnateFrame\'s outer `className` prop, not `contentClassName` (would visually disconnect it from the wood-frame border)', () => {
    const source = readTableComponent('opponent-panel.tsx');
    expect(source).toMatch(/<OrnateFrame[^>]*\n\s*className=\{cn\(isCurrentTurn/);
  });
});

describe('material guard: turn-timer-ring.tsx untouched by ornament', () => {
  it('contains none of the ornament identifiers', () => {
    const source = readTableComponent('turn-timer-ring.tsx');
    for (const identifier of ORNAMENT_IDENTIFIERS) {
      expect(source.includes(identifier), `turn-timer-ring.tsx unexpectedly contains "${identifier}"`).toBe(false);
    }
  });
});

describe('material guard: CornerBracket rotations are distinct per corner', () => {
  it('ornate-frame.tsx assigns 4 structurally-distinct rotation classes, one per corner, matching that corner\'s position', () => {
    // Guards against a copy-paste/off-by-90 bug: a bracket reused with the
    // wrong rotation (or two corners sharing the same rotation) would be a
    // real, visible artwork bug that a test only checking "4 brackets exist"
    // (as this suite otherwise does for the adopter files) would miss.
    const source = readTableComponent('ornate-frame.tsx');
    const calls = [...source.matchAll(/<CornerBracket size=\{size\} className="([^"]*)"\s*\/>/g)].map((m) => m[1]);
    expect(calls.length, 'expected exactly 4 CornerBracket call sites in OrnateFrame').toBe(4);

    // Each call's className must place it at one distinct corner (top/left
    // vs top/right vs bottom/left vs bottom/right)...
    const cornerPositions = calls.map((cls) => {
      const vertical = cls.includes('top-0') ? 'top' : cls.includes('bottom-0') ? 'bottom' : null;
      const horizontal = cls.includes('left-0') ? 'left' : cls.includes('right-0') ? 'right' : null;
      return `${vertical}-${horizontal}`;
    });
    expect(new Set(cornerPositions).size, `expected 4 distinct corners, got: ${cornerPositions.join(', ')}`).toBe(4);

    // ...and each corner's rotation must match the artwork's native
    // orientation (a top-left corner motif: horizontal arm along the top,
    // vertical arm down the left) rotated the correct multiple of 90deg to
    // reach that corner. No rotate-* class at all means 0deg (native
    // top-left orientation) — deliberately not asserting a literal
    // `rotate-0` token since Tailwind doesn't emit one for "no rotation".
    function rotationOf(cls: string): 0 | 90 | 180 | 270 {
      // Order matters: '-rotate-90' (negative) is a superstring-match trap
      // for a naive '.includes(\'rotate-90\')' check, so it must be tested
      // before the bare 'rotate-90' (positive) case.
      if (cls.includes('-rotate-90')) return 270;
      if (cls.includes('rotate-90')) return 90;
      if (cls.includes('rotate-180')) return 180;
      return 0;
    }
    const expectedRotationByCorner: Record<string, 0 | 90 | 180 | 270> = {
      'top-left': 0,
      'top-right': 90,
      'bottom-right': 180,
      'bottom-left': 270,
    };
    calls.forEach((cls, i) => {
      const corner = cornerPositions[i];
      expect(rotationOf(cls), `${corner} bracket className="${cls}"`).toBe(expectedRotationByCorner[corner]);
    });
  });
});

describe('material guard: frame-wood box-shadow does not silently clobber ring-* turn highlight', () => {
  it("frame-wood's box-shadow composes via Tailwind's shared --tw-shadow chain, not a raw literal", () => {
    // opponent-panel.tsx conditionally applies `ring-2 ring-frc-blue-text`
    // (Tailwind's ring utility) to OrnateFrame's `className`, which lands on
    // the SAME outer element that always carries `frame-wood`. Confirmed via
    // a real `npm run build` (.next/static/chunks/*.css): `.ring-2` and
    // `.frame-wood` both compile into the SAME `@layer utilities`, with
    // EQUAL specificity (one class selector each). Per CSS cascade rules,
    // for two same-specificity/same-layer rules setting the same property
    // on the same element, the rule appearing LAST in the stylesheet wins
    // OUTRIGHT — box-shadow does not merge across separate rules. Tailwind's
    // own ring/shadow utilities avoid this exact footgun by never setting a
    // raw `box-shadow: <literal>`; every one of them composes through the
    // shared `--tw-inset-shadow`/`--tw-inset-ring-shadow`/
    // `--tw-ring-offset-shadow`/`--tw-ring-shadow`/`--tw-shadow` chain, e.g.
    // the actual compiled `.ring-2` rule:
    //   .ring-2{--tw-ring-shadow:...;box-shadow:var(--tw-inset-shadow),
    //   var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow),
    //   var(--tw-ring-shadow), var(--tw-shadow)}
    // frame-wood currently sets a raw literal box-shadow instead, and its
    // rule is generated AFTER `.ring-2` in the utilities layer — so it
    // silently and completely overrides ring-2's box-shadow. Net effect: the
    // isCurrentTurn turn-highlight ring never renders once OrnateFrame's
    // frame-wood background is present (opponent-panel.tsx's only real
    // consumer of the ring). This is a genuine, build-confirmed regression,
    // not a theoretical one — see tester report. Fix belongs in the
    // `frame-wood` (and `panel-plaque`, same footgun, unadopted so lower
    // urgency) recipe itself: set `--tw-shadow: <the decorative shadow
    // list>;` and `box-shadow: var(--tw-inset-shadow), var(--tw-inset-ring-shadow),
    // var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow);`
    // (Tailwind's own composable-shadow convention) instead of a bare
    // `box-shadow: <literal>;`.
    const source = readFileSync(GLOBALS_CSS_PATH, 'utf-8');
    const frameWoodBlock = /@utility frame-wood \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(frameWoodBlock, '@utility frame-wood block not found in globals.css — source shape changed').not.toBeNull();
    // Must set the decorative shadow via --tw-shadow (never a raw box-shadow
    // literal), and the final box-shadow declaration must be the FULL
    // 5-variable composition Tailwind's own ring/shadow utilities use — not
    // just var(--tw-shadow) alone, which would silently drop --tw-ring-shadow
    // (and the other three) the instant a real ring-* utility is combined
    // with this class, reintroducing the exact same clobbering bug in a
    // subtler form.
    expect(frameWoodBlock).toMatch(/--tw-shadow:/);
    expect(frameWoodBlock).toMatch(
      /box-shadow:\s*var\(--tw-inset-shadow\),\s*var\(--tw-inset-ring-shadow\),\s*var\(--tw-ring-offset-shadow\),\s*var\(--tw-ring-shadow\),\s*var\(--tw-shadow\)/,
    );
  });
});

/**
 * Phase 2 Round 2 ("lacquer/gold buttons + plaque material on dense claim
 * UI + OrnateFrame on win screens") regression guards. Same source-
 * inspection convention as the Round 1 suites above.
 */
describe('material guard (round 2): claim-action-bar.tsx and rob-kong-prompt.tsx positioning untouched', () => {
  it("claim-action-bar.tsx's cluster wrapper className still contains the Phase 1 anchor tokens", () => {
    const source = readTableComponent('claim-action-bar.tsx');
    expect(source).toContain('fixed right-4 bottom-4 left-4 z-30');
    expect(source).toContain('md:absolute');
    expect(source).toContain('md:bottom-full');
  });

  it("rob-kong-prompt.tsx's POSITION_CLASS still contains the Phase 1 anchor tokens", () => {
    const source = readTableComponent('rob-kong-prompt.tsx');
    expect(source).toContain('fixed right-4 bottom-4 left-4 z-30');
    expect(source).toContain('md:absolute');
    expect(source).toContain('md:bottom-full');
  });
});

describe('material guard (round 2): touch targets preserved', () => {
  it('claim-action-bar.tsx and rob-kong-prompt.tsx still declare h-11 min-w-11 for TOUCH_TARGET_CLASS', () => {
    for (const file of ['claim-action-bar.tsx', 'rob-kong-prompt.tsx']) {
      const source = readTableComponent(file);
      expect(source, `${file} missing TOUCH_TARGET_CLASS`).toContain("const TOUCH_TARGET_CLASS = 'h-11 min-w-11");
    }
  });
});

describe('material guard (round 2): dense-UI rule — plaque only, no ornament brackets on claim rows', () => {
  it('claim-action-bar.tsx and rob-kong-prompt.tsx contain no OrnateFrame or CornerBracket', () => {
    for (const file of ['claim-action-bar.tsx', 'rob-kong-prompt.tsx']) {
      const source = readTableComponent(file);
      expect(source.includes('OrnateFrame'), `${file} unexpectedly contains "OrnateFrame"`).toBe(false);
      expect(source.includes('CornerBracket'), `${file} unexpectedly contains "CornerBracket"`).toBe(false);
    }
  });
});

describe('material guard (round 2): button.tsx defines lacquer and gold variants', () => {
  it('the variants object declares both new keys', () => {
    const source = readFileSync(BUTTON_PATH, 'utf-8');
    expect(source).toMatch(/lacquer:\s*\n?\s*"/);
    expect(source).toMatch(/gold:\s*"/);
  });
});

describe('material guard (round 2): blue-border sweep is complete', () => {
  it('no file under src/components/table contains border-primary-hover/70', () => {
    const files = readdirSync(TABLE_COMPONENTS_DIR).filter((name) => name.endsWith('.tsx'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readTableComponent(file);
      expect(source.includes('border-primary-hover/70'), `${file} still contains "border-primary-hover/70"`).toBe(false);
    }
  });
});

describe('material guard (round 2): win screens framed', () => {
  it('hand-over-panel.tsx and match-standings.tsx reference OrnateFrame', () => {
    for (const file of ['hand-over-panel.tsx', 'match-standings.tsx']) {
      const source = readTableComponent(file);
      expect(source.includes('OrnateFrame'), `${file} does not contain "OrnateFrame"`).toBe(true);
    }
  });

  it('hand-over-panel.tsx still contains the buzzer animation classes after the OrnateFrame wrap', () => {
    const source = readTableComponent('hand-over-panel.tsx');
    expect(source).toContain('animate-buzzer-edge-flash');
    expect(source).toContain('animate-buzzer-pulse');
  });
});
