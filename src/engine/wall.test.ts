import { describe, expect, it } from 'vitest';
import { createTileSet } from './tiles';
import { drawFromHead, drawFromTail, remaining, type Wall } from './wall';

describe('wall', () => {
  it('drawFromHead returns the first tile and a wall shortened by one', () => {
    const wall: Wall = createTileSet();
    const { tile, wall: next } = drawFromHead(wall);
    expect(tile).toEqual(wall[0]);
    expect(next).toHaveLength(wall.length - 1);
    expect(next[0]).toEqual(wall[1]);
  });

  it('drawFromTail returns the last tile and a wall shortened by one', () => {
    const wall: Wall = createTileSet();
    const { tile, wall: next } = drawFromTail(wall);
    expect(tile).toEqual(wall[wall.length - 1]);
    expect(next).toHaveLength(wall.length - 1);
    expect(next[next.length - 1]).toEqual(wall[wall.length - 2]);
  });

  it('remaining reports wall length and decrements per draw', () => {
    const wall: Wall = createTileSet();
    expect(remaining(wall)).toBe(144);
    const { wall: afterOne } = drawFromHead(wall);
    expect(remaining(afterOne)).toBe(143);
    const { wall: afterTwo } = drawFromTail(afterOne);
    expect(remaining(afterTwo)).toBe(142);
  });

  it('interleaved head and tail draws never return the same tile and consume the correct ends', () => {
    let wall: Wall = createTileSet();
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const head = drawFromHead(wall);
      expect(seen.has(head.tile.id)).toBe(false);
      seen.add(head.tile.id);
      wall = head.wall;

      const tail = drawFromTail(wall);
      expect(seen.has(tail.tile.id)).toBe(false);
      seen.add(tail.tile.id);
      wall = tail.wall;
    }
    expect(seen.size).toBe(20);
  });

  it('sequential tail draws walk backward from the last index', () => {
    const wall: Wall = createTileSet();
    const expectedOrder = [wall[143], wall[142], wall[141]];
    let current: Wall = wall;
    const drawn = [];
    for (let i = 0; i < 3; i++) {
      const { tile, wall: next } = drawFromTail(current);
      drawn.push(tile);
      current = next;
    }
    expect(drawn).toEqual(expectedOrder);
  });

  it('drawing from an empty wall throws', () => {
    const emptyWall: Wall = [];
    expect(() => drawFromHead(emptyWall)).toThrow();
    expect(() => drawFromTail(emptyWall)).toThrow();
  });

  it('draw primitives do not mutate the input wall', () => {
    const wall: Wall = createTileSet();
    const originalIds = wall.map((t) => t.id);
    drawFromHead(wall);
    drawFromTail(wall);
    expect(wall.map((t) => t.id)).toEqual(originalIds);
  });

  // --- Adversarial: exhaustion boundary ---
  it('drawFromHead: the 144th draw succeeds and the 145th throws', () => {
    let wall: Wall = createTileSet();
    for (let i = 1; i <= 144; i++) {
      expect(remaining(wall)).toBe(145 - i);
      const { wall: next } = drawFromHead(wall);
      wall = next;
    }
    expect(remaining(wall)).toBe(0);
    expect(() => drawFromHead(wall)).toThrow();
  });

  it('drawFromTail: the 144th draw succeeds and the 145th throws', () => {
    let wall: Wall = createTileSet();
    for (let i = 1; i <= 144; i++) {
      expect(remaining(wall)).toBe(145 - i);
      const { wall: next } = drawFromTail(wall);
      wall = next;
    }
    expect(remaining(wall)).toBe(0);
    expect(() => drawFromTail(wall)).toThrow();
  });

  it('exhausting via drawFromHead visits every tile exactly once with no gaps or dupes', () => {
    let wall: Wall = createTileSet();
    const originalIds = new Set(wall.map((t) => t.id));
    const drawnIds: string[] = [];
    while (remaining(wall) > 0) {
      const { tile, wall: next } = drawFromHead(wall);
      drawnIds.push(tile.id);
      wall = next;
    }
    expect(drawnIds).toHaveLength(144);
    expect(new Set(drawnIds)).toEqual(originalIds);
  });
});
