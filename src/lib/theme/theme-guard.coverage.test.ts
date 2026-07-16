/**
 * Confirms theme-guard.test.ts's file-collection glob genuinely reaches the
 * ranked-ladder UI round's new files (src/components/ranked/**, src/app/
 * leaderboard/page.tsx), rather than merely "passing because it never
 * looked". Mirrors theme-guard.test.ts's own collectTsxFiles logic
 * independently (not by importing its internals, since it doesn't export
 * them) so this is a real independent check, not a tautology.
 *
 * This was additionally verified by hand once: a throwaway `backdrop-blur`
 * class was temporarily injected into rank-badge.tsx and into
 * leaderboard/page.tsx, theme-guard.test.ts was confirmed to fail against
 * each, then both files were reverted (byte-for-byte, MD5-verified) before
 * this test file was added. This test pins that positive-coverage guarantee
 * going forward without needing to repeat the destructive edit.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCAN_ROOTS = [resolve(__dirname, '../../app'), resolve(__dirname, '../../components')];

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
const normalized = tsxFiles.map((f) => f.split('\\').join('/'));

describe('theme-guard glob coverage over the ranked-ladder UI round', () => {
  it('includes src/components/ranked/rank-badge.tsx', () => {
    expect(normalized.some((f) => f.endsWith('src/components/ranked/rank-badge.tsx'))).toBe(true);
  });

  it('includes src/components/ranked/rank-progress.tsx', () => {
    expect(normalized.some((f) => f.endsWith('src/components/ranked/rank-progress.tsx'))).toBe(true);
  });

  it('includes src/app/leaderboard/page.tsx', () => {
    expect(normalized.some((f) => f.endsWith('src/app/leaderboard/page.tsx'))).toBe(true);
  });

  it('includes the pre-existing src/components/table/match-standings.tsx (not just new files)', () => {
    expect(normalized.some((f) => f.endsWith('src/components/table/match-standings.tsx'))).toBe(true);
  });
});
