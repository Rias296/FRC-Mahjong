import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Regression guard for the oriental-theme overhaul (round 1 + round 2):
 * glassmorphism/backdrop-blur must never silently creep back in (e.g. via a
 * shadcn component regeneration, which defaults new overlays to
 * `backdrop-blur`), the old `glass` utility must stay renamed to `panel`,
 * and the pre-round-1 palette's raw hex literals must never be hardcoded
 * directly in component markup (only as CSS custom-property values in
 * globals.css, which this scan intentionally excludes — it only walks
 * `.tsx` files).
 */

const SCAN_ROOTS = [resolve(__dirname, '../../app'), resolve(__dirname, '../../components')];

// Word-boundary-safe: `\bglass\b` matches a standalone `glass` token (e.g.
// `className="glass ..."` or `cn('glass', ...)`) without false-positiving on
// substrings like "glassmorphism" or "hourglass" (no boundary between
// "glass" and the following word character in either case).
const GLASS_TOKEN_PATTERN = /\bglass\b/;
const BACKDROP_PATTERN = /backdrop-blur|backdrop-filter/;
const BANNED_HEX_LITERALS = ['#0B1120', '#F59E0B', '#2563EB'];

function collectTsxFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      files.push(...collectTsxFiles(fullPath));
    } else if (stats.isFile() && fullPath.endsWith('.tsx')) {
      files.push(fullPath);
    }
  }
  return files;
}

const tsxFiles = SCAN_ROOTS.flatMap((root) => collectTsxFiles(root));

describe('theme guard: no glassmorphism regressions', () => {
  it('scanned at least one .tsx file under src/app and src/components', () => {
    // Sanity check on the scan itself — an empty file list would make every
    // other assertion in this suite vacuously true and silently useless.
    expect(tsxFiles.length).toBeGreaterThan(0);
  });

  it('contains no backdrop-blur or backdrop-filter usage', () => {
    const offenders = tsxFiles.filter((file) => BACKDROP_PATTERN.test(readFileSync(file, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('contains no standalone "glass" class token (renamed to "panel")', () => {
    const offenders = tsxFiles.filter((file) => GLASS_TOKEN_PATTERN.test(readFileSync(file, 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('contains no hardcoded pre-round-1 palette hex literals', () => {
    const offenders: string[] = [];
    for (const file of tsxFiles) {
      const content = readFileSync(file, 'utf-8');
      for (const hex of BANNED_HEX_LITERALS) {
        if (content.includes(hex)) {
          offenders.push(`${file}: ${hex}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
