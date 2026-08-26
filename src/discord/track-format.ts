import type { PlayerSnapshot, PlayerStatus } from '../player/guild-player.js';
import type { Track } from '../player/track.js';

/** Upcoming tracks listed by `/queue` before it starts summarising. */
export const QUEUE_PAGE_SIZE = 10;

const STATUS_LABEL: Record<PlayerStatus, string> = {
  idle: 'Idle',
  playing: 'Playing',
  paused: 'Paused',
};

/** `mm:ss` (or `h:mm:ss`), or `unknown length` when the source cannot tell. */
export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return 'unknown length';
  }

  const totalSeconds = Math.round(durationMs / 1000);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);

  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

function requester(track: Track): string {
  return `<@${track.requestedByUserId}>`;
}

/** One line per queued track: position, title, length, requester. */
function trackLine(track: Track, position: number): string {
  return `${position}. **${track.title}** [${formatDuration(track.durationMs)}] - ${requester(track)}`;
}

export function formatNowPlaying(snapshot: PlayerSnapshot): string {
  const { current } = snapshot;
  if (current === undefined) {
    return 'Nothing is playing right now.';
  }

  return [
    `**${STATUS_LABEL[snapshot.status]}:** ${current.title}`,
    `Length: ${formatDuration(current.durationMs)}`,
    `Requested by: ${requester(current)}`,
    `Up next: ${snapshot.upcoming.length} track(s) in the queue.`,
  ].join('\n');
}

export function formatQueue(snapshot: PlayerSnapshot, pageSize = QUEUE_PAGE_SIZE): string {
  const { current, upcoming } = snapshot;

  if (current === undefined && upcoming.length === 0) {
    return 'The queue is empty and nothing is playing.';
  }

  const lines: string[] = [];
  lines.push(
    current === undefined
      ? '**Now playing:** nothing'
      : `**${STATUS_LABEL[snapshot.status]}:** ${current.title} ` +
          `[${formatDuration(current.durationMs)}] - ${requester(current)}`,
  );

  if (upcoming.length === 0) {
    lines.push('', 'Nothing queued after this one.');
    return lines.join('\n');
  }

  lines.push('', `**Queue (${upcoming.length}):**`);
  for (const [index, track] of upcoming.slice(0, pageSize).entries()) {
    lines.push(trackLine(track, index + 1));
  }

  const hidden = upcoming.length - pageSize;
  if (hidden > 0) {
    lines.push(`...and ${hidden} more.`);
  }

  return lines.join('\n');
}
