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
import { createGame } from '@/lib/api-client';
import { loadSession, saveSession, type GameSession } from '@/lib/session';
import { LOBBY_STRINGS } from '@/lib/i18n/lobby';

export default function Home(): React.JSX.Element {
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [resumeSession, setResumeSession] = useState<GameSession | null>(null);

  useEffect(() => {
    // localStorage is browser-only; reading it must be deferred to a
    // post-mount effect (not computed during render) to avoid an SSR
    // hydration mismatch. This is a one-shot read of already-persisted
    // session state, not an external-store subscription.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResumeSession(loadSession());
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
      const result = await createGame({ displayName: trimmedName });
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

      {resumeSession !== null && (
        <div className="glass w-full max-w-md rounded-xl px-4 py-3 text-sm">
          <span className="text-muted-foreground">{LOBBY_STRINGS.resumeSessionPrefix} </span>
          <Link href={`/room/${resumeSession.roomCode}`} className="font-medium text-primary hover:underline">
            {LOBBY_STRINGS.resumeSessionLink} ({resumeSession.roomCode})
          </Link>
        </div>
      )}

      <div className="grid w-full max-w-md gap-6">
        <Card className="glass">
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

        <Card className="glass">
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
