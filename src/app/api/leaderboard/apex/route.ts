/**
 * GET /api/leaderboard/apex — the public Apex Grandmaster leaderboards
 * (founding order + RP order). No auth required.
 */

import { getDb } from '@/server/db';
import { getApexLeaderboards } from '@/server/ranked';
import type { ApexLeaderboardResponse } from '@/lib/protocol';

export async function GET(): Promise<Response> {
  const db = getDb();
  const result = await getApexLeaderboards(db);

  const response: ApexLeaderboardResponse = {
    foundingOrder: result.foundingOrder,
    rpOrder: result.rpOrder,
  };

  return Response.json(response, { status: 200 });
}
