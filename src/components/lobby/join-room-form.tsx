'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field';
import { ensureProfile, joinGame } from '@/lib/api-client';
import { saveSession, type GameSession } from '@/lib/session';
import { normalizeRoomCode, isValidRoomCode } from '@/lib/room-code';
import { LOBBY_STRINGS } from '@/lib/i18n/lobby';

export interface JoinRoomFormProps {
  readonly initialCode?: string;
  readonly lockCode?: boolean;
  readonly onJoined: (session: GameSession) => void;
}

export function JoinRoomForm({ initialCode, lockCode = false, onJoined }: JoinRoomFormProps): React.JSX.Element {
  const [roomCode, setRoomCode] = useState(initialCode ?? '');
  const [displayName, setDisplayName] = useState('');
  const [roomCodeError, setRoomCodeError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (submitting) return;

    const normalizedCode = normalizeRoomCode(roomCode);
    const trimmedName = displayName.trim();

    let hasError = false;
    if (!isValidRoomCode(normalizedCode)) {
      setRoomCodeError(LOBBY_STRINGS.roomCodeInvalidFormat);
      hasError = true;
    } else {
      setRoomCodeError(null);
    }
    if (trimmedName.length === 0) {
      setNameError(LOBBY_STRINGS.displayNameRequired);
      hasError = true;
    } else {
      setNameError(null);
    }
    if (hasError) return;

    setSubmitting(true);
    try {
      // Best-effort: an unavailable ranked profile (e.g. offline) must never
      // block joining a casual match — ensureProfile returns null rather
      // than throwing, and `profileToken: undefined` just means this match
      // settles unranked for this seat.
      const profileToken = (await ensureProfile(trimmedName)) ?? undefined;
      const result = await joinGame(normalizedCode, { displayName: trimmedName, profileToken });
      if (result.ok) {
        const session: GameSession = {
          roomCode: normalizedCode,
          seat: result.data.seat,
          playerToken: result.data.playerToken,
          displayName: trimmedName,
        };
        saveSession(session);
        onJoined(session);
        return;
      }

      switch (result.error.kind) {
        case 'join-rejected':
          toast.error(
            result.error.code === 'game-full' ? LOBBY_STRINGS.errorRoomFull : LOBBY_STRINGS.errorAlreadyStarted,
          );
          break;
        case 'not-found':
          toast.error(LOBBY_STRINGS.errorRoomNotFound);
          break;
        case 'network-error':
          toast.error(LOBBY_STRINGS.errorNetwork);
          break;
        case 'validation-error':
          toast.error(result.error.message || LOBBY_STRINGS.errorGeneric);
          break;
        default:
          toast.error(LOBBY_STRINGS.errorServer);
          break;
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <FieldGroup>
        {!lockCode && (
          <Field data-invalid={roomCodeError !== null || undefined}>
            <FieldLabel htmlFor="join-room-code">{LOBBY_STRINGS.roomCodeLabel}</FieldLabel>
            <Input
              id="join-room-code"
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value)}
              placeholder={LOBBY_STRINGS.roomCodePlaceholder}
              aria-invalid={roomCodeError !== null || undefined}
              maxLength={6}
              autoCapitalize="characters"
              disabled={submitting}
            />
            {roomCodeError !== null && <FieldError>{roomCodeError}</FieldError>}
          </Field>
        )}
        <Field data-invalid={nameError !== null || undefined}>
          <FieldLabel htmlFor="join-display-name">{LOBBY_STRINGS.displayNameLabel}</FieldLabel>
          <Input
            id="join-display-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={LOBBY_STRINGS.displayNamePlaceholder}
            aria-invalid={nameError !== null || undefined}
            disabled={submitting}
          />
          {nameError !== null && <FieldError>{nameError}</FieldError>}
        </Field>
        <Button type="submit" disabled={submitting}>
          {submitting ? LOBBY_STRINGS.joiningMatchButton : LOBBY_STRINGS.joinMatchButton}
        </Button>
      </FieldGroup>
    </form>
  );
}
