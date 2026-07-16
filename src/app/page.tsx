'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Field, FieldGroup, FieldLabel, FieldError } from '@/components/ui/field';
import { JoinRoomForm } from '@/components/lobby/join-room-form';
import { RankProgress } from '@/components/ranked/rank-progress';
import { Skeleton } from '@/components/ui/skeleton';
import { createGame, ensureProfile, getMyProfile } from '@/lib/api-client';
import { loadSession, saveSession, type GameSession } from '@/lib/session';
import { LOBBY_STRINGS } from '@/lib/i18n/lobby';
import { RANKED_STRINGS } from '@/lib/i18n/ranked';
import { asTierBand } from '@/lib/theme/frc';
import type { ProfileMeResponse } from '@/lib/protocol';

export default function Home(): React.JSX.Element {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resumeSession, setResumeSession] = useState<GameSession | null>(null);
  const [profile, setProfile] = useState<ProfileMeResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);

  useEffect(() => {
    // localStorage is browser-only; reading it must be deferred to a
    // post-mount effect (not computed during render) to avoid an SSR
    // hydration mismatch. This is a one-shot read of already-persisted
    // session state, not an external-store subscription.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResumeSession(loadSession());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await ensureProfile();
      if (token === null) {
        if (!cancelled) setProfileLoading(false);
        return;
      }
      const result = await getMyProfile(token);
      if (cancelled) return;
      if (result.ok) setProfile(result.data);
      setProfileLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating) return;

    const trimmedName = displayName.trim();
    if (trimmedName.length === 0) {
      setNameError(LOBBY_STRINGS.displayNameRequired);
      return;
    }
    setNameError(null);

    setCreating(true);
    try {
      // Best-effort, same as JoinRoomForm: an unavailable ranked profile must
      // never block creating a casual match.
      const profileToken = (await ensureProfile(trimmedName)) ?? undefined;
      const result = await createGame({ displayName: trimmedName, profileToken });
      if (result.ok) {
        saveSession({
          roomCode: result.data.roomCode,
          seat: 0,
          playerToken: result.data.playerToken,
          displayName: trimmedName,
        });
        router.push(`/room/${result.data.roomCode}`);
        return;
      }

      switch (result.error.kind) {
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
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-4 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="font-display text-3xl text-foreground sm:text-4xl">{LOBBY_STRINGS.appTitle}</h1>
        <p className="max-w-md text-muted-foreground">{LOBBY_STRINGS.appTagline}</p>
      </div>

      <Card className="panel w-full max-w-md">
        <CardHeader>
          <CardTitle>{RANKED_STRINGS.profileCardHeading}</CardTitle>
        </CardHeader>
        <CardContent>
          {profileLoading ? (
            <Skeleton className="h-14 w-full" />
          ) : profile !== null ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">{profile.displayName}</span>
              <RankProgress rankPoints={profile.rankPoints} tier={asTierBand(profile.tier)} division={profile.division} />
            </div>
          ) : null}
        </CardContent>
      </Card>

      {resumeSession !== null && (
        <div className="panel w-full max-w-md rounded-xl px-4 py-3 text-sm">
          <span className="text-muted-foreground">{LOBBY_STRINGS.resumeSessionPrefix} </span>
          <Link href={`/room/${resumeSession.roomCode}`} className="font-medium text-frc-blue-text hover:underline">
            {LOBBY_STRINGS.resumeSessionLink} ({resumeSession.roomCode})
          </Link>
        </div>
      )}

      <div className="grid w-full max-w-md gap-6">
        <Card className="panel">
          <CardHeader>
            <CardTitle>{LOBBY_STRINGS.createMatchButton}</CardTitle>
            <CardDescription>{LOBBY_STRINGS.appTagline}</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleCreate}>
              <FieldGroup>
                <Field data-invalid={nameError !== null || undefined}>
                  <FieldLabel htmlFor="create-display-name">{LOBBY_STRINGS.displayNameLabel}</FieldLabel>
                  <Input
                    id="create-display-name"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder={LOBBY_STRINGS.displayNamePlaceholder}
                    aria-invalid={nameError !== null || undefined}
                    disabled={creating}
                  />
                  {nameError !== null && <FieldError>{nameError}</FieldError>}
                </Field>
                <Button type="submit" disabled={creating}>
                  {creating ? LOBBY_STRINGS.creatingMatchButton : LOBBY_STRINGS.createMatchButton}
                </Button>
              </FieldGroup>
            </form>
          </CardContent>
        </Card>

        <Card className="panel">
          <CardHeader>
            <CardTitle>{LOBBY_STRINGS.joinMatchButton}</CardTitle>
          </CardHeader>
          <CardContent>
            <JoinRoomForm
              onJoined={(session) => {
                router.push(`/room/${session.roomCode}`);
              }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
