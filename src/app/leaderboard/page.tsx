'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getApexLeaderboard } from '@/lib/api-client';
import { RANKED_STRINGS } from '@/lib/i18n/ranked';
import { formatRankPoints } from '@/lib/theme/frc';
import type { ApexLeaderboardEntry, ApexLeaderboardResponse } from '@/lib/protocol';

interface LeaderboardTableProps {
  readonly heading: string;
  /** null while loading; an empty array is a real, valid "no Apex Grandmasters yet" state. */
  readonly entries: readonly ApexLeaderboardEntry[] | null;
}

/**
 * One leaderboard column (founding order or current-RP order). Exact
 * `rankPoints` is intentionally shown here — the Apex leaderboard is the
 * ONE place an exact RP total is legitimately public (see
 * src/server/ranked.ts's `getApexLeaderboards` doc comment and
 * ClientRankedResultView's redaction rules elsewhere): this is not an
 * accidental leak, do not redact it.
 */
function LeaderboardTable({ heading, entries }: LeaderboardTableProps): React.JSX.Element {
  return (
    <Card className="panel">
      <CardHeader>
        <CardTitle>{heading}</CardTitle>
      </CardHeader>
      <CardContent>
        {entries === null ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : entries.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{RANKED_STRINGS.leaderboardEmptyState}</EmptyTitle>
              <EmptyDescription>{RANKED_STRINGS.leaderboardHeading}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{RANKED_STRINGS.leaderboardRankColumn}</TableHead>
                <TableHead>{RANKED_STRINGS.leaderboardNameColumn}</TableHead>
                <TableHead className="text-right">{RANKED_STRINGS.leaderboardPointsColumn}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry, index) => (
                <TableRow key={entry.profileId}>
                  <TableCell className="font-hud text-muted-foreground">{index + 1}</TableCell>
                  <TableCell className="font-medium text-foreground">{entry.displayName}</TableCell>
                  <TableCell className="text-right font-hud text-accent">{formatRankPoints(entry.rankPoints)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Public Apex Grandmaster leaderboard — two orderings of every profile that
 * has ever reached Apex (founding order + current-RP order), from
 * GET /api/leaderboard/apex. No auth required; renders (possibly empty)
 * regardless of whether the viewer has a ranked profile at all.
 */
export default function LeaderboardPage(): React.JSX.Element {
  const [data, setData] = useState<ApexLeaderboardResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getApexLeaderboard();
      if (!cancelled && result.ok) setData(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex flex-1 flex-col items-center gap-8 px-4 py-12">
      <h1 className="font-display text-3xl text-foreground sm:text-4xl">{RANKED_STRINGS.leaderboardHeading}</h1>
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-2">
        <LeaderboardTable heading={RANKED_STRINGS.foundingOrderHeading} entries={data?.foundingOrder ?? null} />
        <LeaderboardTable heading={RANKED_STRINGS.rpOrderHeading} entries={data?.rpOrder ?? null} />
      </div>
    </div>
  );
}
