import { normalizeRoomCode } from '@/lib/room-code';
import { RoomClient } from './room-client';

export default async function RoomPage({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<React.JSX.Element> {
  const { code } = await params;
  return <RoomClient code={normalizeRoomCode(code)} />;
}
