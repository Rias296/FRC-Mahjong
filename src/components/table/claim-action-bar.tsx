import { Button } from '@/components/ui/button';
import { actionLabel } from '@/lib/theme/frc';
import { TABLE_STRINGS } from '@/lib/i18n/table';
import { cn } from '@/lib/utils';
import type { ClaimOffer, OwnTurnDeclaration } from '@/lib/table/interactions';
import type { RackSelectionMode } from './player-rack';

/**
 * Single floating contextual action cluster, covering both:
 *  - claim offers on another player's discard (chow/pung/kong/hu/pass), and
 *  - the viewer's own-turn declarations (draw/hu/added-kong/concealed-kong)
 *    that used to live in game-table.tsx's static `ownTurnControls` block.
 *
 * Anchored above/right of the local rack row on md+ (the caller wraps this +
 * the PlayerRack in a `relative` container), so it never covers the
 * always-visible rack on the md+ fixed-viewport layout (see game-table.tsx).
 * Below md, the game screen still scrolls (mobile zero-scroll is out of
 * scope this round), so this stays viewport-`fixed` there instead — a
 * rack-relative anchor would scroll the buttons off-screen along with the
 * rack during a live, time-sensitive claim window. Purely presentational — every branch below mirrors
 * the exact conditional mount/unmount gating `deriveInteractions` (in
 * src/lib/table/interactions.ts) already produces; that gating logic is not
 * touched here.
 */
export interface ClaimActionBarProps {
  /** Claim offer for another player's discard, or an empty array when none is open. */
  readonly offer: readonly ClaimOffer[];
  readonly canDraw: boolean;
  readonly ownTurnDeclarations: readonly OwnTurnDeclaration[];
  readonly selectionMode: RackSelectionMode;
  readonly selectedTileCount: number;
  readonly pending: boolean;
  readonly onClaimAction: (claim: ClaimOffer) => void;
  readonly onDraw: () => void;
  readonly onDeclareHu: () => void;
  readonly onStartAddedKongSelect: () => void;
  readonly onStartConcealedKongSelect: () => void;
  readonly onConfirmChow: () => void;
  readonly onCancelSelection: () => void;
}

const TOUCH_TARGET_CLASS = 'h-11 min-w-11 px-4 text-base';

export function ClaimActionBar({
  offer,
  canDraw,
  ownTurnDeclarations,
  selectionMode,
  selectedTileCount,
  pending,
  onClaimAction,
  onDraw,
  onDeclareHu,
  onStartAddedKongSelect,
  onStartConcealedKongSelect,
  onConfirmChow,
  onCancelSelection,
}: ClaimActionBarProps): React.JSX.Element | null {
  const hasOwnTurnControls = canDraw || ownTurnDeclarations.length > 0;
  const showChowConfirm = selectionMode === 'chow-select';
  // Claim buttons and own-turn buttons are hidden during chow-tile selection,
  // matching the original game-table.tsx guard (`selectionMode !== 'chow-select'`).
  const showClaimButtons = offer.length > 0 && !showChowConfirm;
  const showOwnTurnButtons = hasOwnTurnControls && !showChowConfirm;
  const showAddedKongPrompt = selectionMode === 'added-kong-select';
  const showConcealedKongPrompt = selectionMode === 'concealed-kong-select';

  if (!showClaimButtons && !showOwnTurnButtons && !showChowConfirm && !showAddedKongPrompt && !showConcealedKongPrompt) {
    return null;
  }

  return (
    <div className="fixed right-4 bottom-4 left-4 z-30 flex flex-col items-center gap-2 sm:right-auto sm:left-1/2 sm:w-auto sm:-translate-x-1/2 md:absolute md:right-2 md:bottom-full md:left-auto md:mb-2 md:w-auto md:translate-x-0 md:items-end">
      {showClaimButtons && (
        <div
          className="panel-plaque flex flex-wrap items-center justify-center gap-2 rounded-xl p-3 shadow-lg"
          role="group"
          aria-label={TABLE_STRINGS.claimActionsLabel}
        >
          {offer.map((claim) => {
            if (claim === 'hu') {
              return (
                <Button
                  key={claim}
                  variant="lacquer"
                  disabled={pending}
                  onClick={() => onClaimAction(claim)}
                  className={TOUCH_TARGET_CLASS}
                >
                  {actionLabel('hu')}
                </Button>
              );
            }
            if (claim === 'pass') {
              return (
                <Button
                  key={claim}
                  variant="outline"
                  disabled={pending}
                  onClick={() => onClaimAction(claim)}
                  className={TOUCH_TARGET_CLASS}
                >
                  {actionLabel(claim)}
                </Button>
              );
            }
            return (
              <Button
                key={claim}
                variant="gold"
                disabled={pending}
                onClick={() => onClaimAction(claim)}
                className={TOUCH_TARGET_CLASS}
              >
                {actionLabel(claim)}
              </Button>
            );
          })}
        </div>
      )}

      {showOwnTurnButtons && (
        <div
          className="panel-plaque flex flex-wrap items-center justify-center gap-2 rounded-xl p-3 shadow-lg"
          role="group"
          aria-label={TABLE_STRINGS.turnActionsLabel}
        >
          {canDraw && (
            <Button disabled={pending} onClick={onDraw} className={TOUCH_TARGET_CLASS}>
              {actionLabel('draw')}
            </Button>
          )}
          {ownTurnDeclarations.includes('hu') && (
            <Button variant="lacquer" disabled={pending} onClick={onDeclareHu} className={TOUCH_TARGET_CLASS}>
              {actionLabel('hu')}
            </Button>
          )}
          {ownTurnDeclarations.includes('added-kong') && (
            <Button
              variant="gold"
              disabled={pending}
              onClick={onStartAddedKongSelect}
              className={TOUCH_TARGET_CLASS}
            >
              {TABLE_STRINGS.addedKongButton}
            </Button>
          )}
          {ownTurnDeclarations.includes('concealed-kong') && (
            <Button
              variant="gold"
              disabled={pending}
              onClick={onStartConcealedKongSelect}
              className={TOUCH_TARGET_CLASS}
            >
              {TABLE_STRINGS.concealedKongButton}
            </Button>
          )}
        </div>
      )}

      {showChowConfirm && (
        <div className="panel-plaque flex flex-col items-center gap-2 rounded-xl p-3 shadow-lg">
          <p className="text-xs text-muted-foreground">{TABLE_STRINGS.chowSelectPrompt}</p>
          <div className="flex items-center gap-2">
            <Button
              disabled={pending || selectedTileCount !== 2}
              onClick={onConfirmChow}
              className={cn(TOUCH_TARGET_CLASS, 'bg-accent text-accent-foreground hover:bg-accent/90')}
            >
              {TABLE_STRINGS.chowSelectConfirm}
            </Button>
            <Button variant="outline" disabled={pending} onClick={onCancelSelection} className={TOUCH_TARGET_CLASS}>
              {TABLE_STRINGS.selectionCancelButton}
            </Button>
          </div>
        </div>
      )}

      {(showAddedKongPrompt || showConcealedKongPrompt) && (
        <div className="panel-plaque flex flex-col items-center gap-1 rounded-xl p-3 shadow-lg">
          <p className="text-xs text-muted-foreground">
            {showAddedKongPrompt ? TABLE_STRINGS.addedKongSelectPrompt : TABLE_STRINGS.concealedKongSelectPrompt}
          </p>
          <Button variant="outline" size="sm" disabled={pending} onClick={onCancelSelection}>
            {TABLE_STRINGS.selectionCancelButton}
          </Button>
        </div>
      )}
    </div>
  );
}
