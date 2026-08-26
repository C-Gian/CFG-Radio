import { describe, expect, it, vi } from 'vitest';

import { play } from '../src/discord/commands/play.js';
import { ProviderError } from '../src/player/provider-error.js';
import {
  contextWithPlayer,
  fakeImmediateSource,
  fakeChatInput,
  fakeContext,
  fakePlaylist,
  replyContent,
} from './helpers/context.js';
import { localTrack } from './helpers/fake-transport.js';

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function playInteraction(url: string, overrides: Record<string, unknown> = {}) {
  return fakeChatInput({ stringOptions: { url }, ...overrides });
}

describe('/play - input handling', () => {
  it.each([
    ['https://www.youtube.com/results?search_query=lofi', 'Search is not available'],
    ['https://soundcloud.com/artist/track', 'Only YouTube video and playlist URLs'],
    [
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'Only YouTube video and playlist URLs',
    ],
    ['not a url at all', 'Search is not available'],
  ])('refuses %s before touching the network', async (url, expected) => {
    const { context, players, fetchMetadataWithSource } = fakeContext();
    const { interaction, reply } = playInteraction(url);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain(expected);
    expect(fetchMetadataWithSource).not.toHaveBeenCalled();
    expect(players.join).not.toHaveBeenCalled();
  });

  it('resolves the metadata of a supported video with the canonical URL', async () => {
    const { context, fetchMetadataWithSource } = contextWithPlayer('guild-1', null);
    const { interaction } = playInteraction('https://youtu.be/dQw4w9WgXcQ?t=30');

    await play.execute(interaction, context);

    expect(fetchMetadataWithSource).toHaveBeenCalledWith(VIDEO_URL, 'dQw4w9WgXcQ');
  });

  it('keeps watch video plus list as one video and never imports the playlist', async () => {
    const { context, fetchMetadataWithSource, fetchPlaylist } = contextWithPlayer('guild-1', null);
    const { interaction } = playInteraction(`${VIDEO_URL}&list=PLabcdefghijklmnop&index=2`);

    await play.execute(interaction, context);

    expect(fetchMetadataWithSource).toHaveBeenCalledWith(VIDEO_URL, 'dQw4w9WgXcQ');
    expect(fetchPlaylist).not.toHaveBeenCalled();
  });
});

describe('/play - playlist import', () => {
  const playlistUrl = 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop';

  it('starts the first track and enqueues the remainder when idle', async () => {
    const { context, player, fetchMetadataWithSource, fetchPlaylist } = contextWithPlayer(
      'guild-1',
      null,
    );
    const { interaction, reply } = playInteraction(playlistUrl, { userId: 'requester-42' });

    await play.execute(interaction, context);

    expect(fetchPlaylist).toHaveBeenCalledWith(playlistUrl, 'PLabcdefghijklmnop', 100);
    expect(fetchMetadataWithSource).not.toHaveBeenCalled();
    expect(replyContent(reply)).toContain('Playing **A YouTube Song**');
    expect(replyContent(reply)).toContain(
      'Added **3 tracks** from playlist **A YouTube Playlist**',
    );
    expect(player.current).toMatchObject({ sourceId: 'dQw4w9WgXcQ', source: 'youtube' });
    expect(player.snapshot().upcoming.map((track) => track.sourceId)).toEqual([
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
    ]);
    expect(
      [player.current, ...player.snapshot().upcoming].every(
        (track) => track?.requestedByUserId === 'requester-42',
      ),
    ).toBe(true);
  });

  it('appends the whole playlist when already playing', async () => {
    const { context, player } = contextWithPlayer();
    await player.enqueue(localTrack('current'));
    await player.enqueue(localTrack('existing'));
    const { interaction, reply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toBe(
      'Added **3 tracks** from playlist **A YouTube Playlist** to the queue.',
    );
    expect(player.snapshot().upcoming.map((track) => track.sourceId)).toEqual([
      'existing',
      'dQw4w9WgXcQ',
      'aaaaaaaaaaa',
      'bbbbbbbbbbb',
    ]);
  });

  it('reports skipped entries compactly', async () => {
    const { context, fetchPlaylist } = contextWithPlayer('guild-1', null);
    fetchPlaylist.mockResolvedValue({ ...fakePlaylist, skippedCount: 3 });
    const { interaction, reply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('3 unavailable entries were skipped.');
  });

  it('uses singular grammar for one skipped entry', async () => {
    const { context, fetchPlaylist } = contextWithPlayer('guild-1', null);
    fetchPlaylist.mockResolvedValue({ ...fakePlaylist, skippedCount: 1 });
    const { interaction, reply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('1 unavailable entry was skipped.');
  });

  it('reports a capped import without treating it as an error', async () => {
    const { context, fetchPlaylist } = contextWithPlayer('guild-1', null);
    fetchPlaylist.mockResolvedValue({ ...fakePlaylist, limited: true });
    const { interaction, reply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('Added first **3 tracks**');
    expect(replyContent(reply)).toContain('Playlist was limited to 3 tracks.');
  });

  it('answers a valid empty or wholly unusable playlist without joining', async () => {
    const { context, fetchPlaylist, players } = fakeContext();
    fetchPlaylist.mockResolvedValue({ ...fakePlaylist, items: [], skippedCount: 4 });
    const { interaction, reply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('no playable tracks');
    expect(replyContent(reply)).toContain('4 unavailable entries');
    expect(players.join).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', 'playlist is unavailable'],
    ['login_required', 'playlist requires login'],
    ['geo_restricted', 'playlist is not available in this region'],
    ['rate_limited', 'rate limiting'],
    ['timeout', 'too long'],
    ['extractor_failed', 'could not read that playlist'],
  ] as const)('answers playlist ProviderError %s without stderr', async (code, expected) => {
    const diagnostic = 'ERROR: secret provider diagnostic';
    const { context, fetchPlaylist, players } = fakeContext();
    fetchPlaylist.mockRejectedValue(new ProviderError(code, 'internal detail', { diagnostic }));
    const { interaction, reply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(replyContent(reply).toLowerCase()).toContain(expected.toLowerCase());
    expect(replyContent(reply)).not.toContain(diagnostic);
    expect(players.join).not.toHaveBeenCalled();
  });

  it('applies voice policy and permissions before playlist extraction', async () => {
    const noVoice = fakeContext();
    const noVoiceCall = playInteraction(playlistUrl, { userChannelId: null });
    await play.execute(noVoiceCall.interaction, noVoice.context);
    expect(noVoice.fetchPlaylist).not.toHaveBeenCalled();

    const noPermission = fakeContext();
    const noPermissionCall = playInteraction(playlistUrl, { missingPermissions: true });
    await play.execute(noPermissionCall.interaction, noPermission.context);
    expect(noPermission.fetchPlaylist).not.toHaveBeenCalled();
  });

  it('defers before doing playlist work', async () => {
    const { context } = contextWithPlayer('guild-1', null);
    const { interaction, deferReply } = playInteraction(playlistUrl);

    await play.execute(interaction, context);

    expect(deferReply).toHaveBeenCalledTimes(1);
  });
});

describe('/play - voice policy', () => {
  it('refuses when the user is not in a voice channel', async () => {
    const { context, fetchMetadataWithSource, players } = fakeContext();
    const { interaction, reply } = playInteraction(VIDEO_URL, { userChannelId: null });

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('Join a voice channel first');
    expect(fetchMetadataWithSource).not.toHaveBeenCalled();
    expect(players.join).not.toHaveBeenCalled();
  });

  it('refuses when the bot is busy in another channel', async () => {
    const { context, fetchMetadataWithSource } = contextWithPlayer('guild-1', 'vc-9');
    const { interaction, reply } = playInteraction(VIDEO_URL, { userChannelId: 'vc-1' });

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('already connected to another voice channel');
    expect(fetchMetadataWithSource).not.toHaveBeenCalled();
  });

  it('refuses when the bot cannot speak in the channel', async () => {
    const { context, fetchMetadataWithSource } = fakeContext();
    const { interaction, reply } = playInteraction(VIDEO_URL, { missingPermissions: true });

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('missing the following permission');
    expect(fetchMetadataWithSource).not.toHaveBeenCalled();
  });

  it('is guild only', async () => {
    const { context } = fakeContext();
    const { interaction, reply } = playInteraction(VIDEO_URL, { guildId: null });

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('inside a server');
  });
});

describe('/play - metadata failures', () => {
  it.each([
    ['unavailable', 'This YouTube video is unavailable.'],
    ['login_required', 'This video requires login and cannot be played.'],
    ['geo_restricted', 'This video is not available in this region.'],
    ['timeout', 'YouTube took too long to respond.'],
    ['rate_limited', 'YouTube is rate limiting me'],
    ['not_found', 'I could not find that video.'],
  ] as const)('answers a %s failure with a short message', async (code, expected) => {
    const { context, players, logger } = fakeContext({
      fetchMetadataWithSource: vi
        .fn()
        .mockRejectedValue(new ProviderError(code, 'internal detail')),
    });
    const { interaction, reply } = playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain(expected);
    expect(players.join).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never shows yt-dlp stderr to the user', async () => {
    const stderr = 'ERROR: [youtube] dQw4w9WgXcQ: Unable to extract player response; nsig failure';
    const { context } = fakeContext({
      fetchMetadataWithSource: vi
        .fn()
        .mockRejectedValue(new ProviderError('extractor_failed', 'boom', { diagnostic: stderr })),
    });
    const { interaction, reply } = playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    const answer = replyContent(reply);
    expect(answer).not.toContain('nsig');
    expect(answer).not.toContain('ERROR:');
    expect(answer).toContain('I could not read that video');
  });

  it('handles an unclassified failure without crashing', async () => {
    const { context } = fakeContext({
      fetchMetadataWithSource: vi.fn().mockRejectedValue(new Error('kaboom')),
    });
    const { interaction, reply } = playInteraction(VIDEO_URL);

    await expect(play.execute(interaction, context)).resolves.toBeUndefined();
    expect(replyContent(reply)).toContain('Something went wrong');
  });
});

describe('/play - queueing', () => {
  it('starts the track when the player is idle', async () => {
    const { context, player } = contextWithPlayer('guild-1', null);
    const { interaction, reply, deferReply, editReply, interactionReply } =
      playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('Playing **A YouTube Song**');
    expect(deferReply).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledTimes(1);
    expect(interactionReply).not.toHaveBeenCalled();
    expect(player.current).toMatchObject({ source: 'youtube', sourceId: 'dQw4w9WgXcQ' });
  });

  it('queues the track when something is already playing', async () => {
    const { context, player } = contextWithPlayer('guild-1', 'vc-1');
    await player.enqueue(localTrack('arpeggio'));
    const { interaction, reply } = playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toBe('Added to queue at position 1: **A YouTube Song**.');
    expect(player.current?.sourceId).toBe('arpeggio');
    expect(player.snapshot().upcoming[0]).toMatchObject({ source: 'youtube' });
  });

  it('reports a playback failure that happens on immediate start', async () => {
    const { context, transport } = contextWithPlayer('guild-1', null);
    transport.failFor(fakeImmediateSource.input);
    const { interaction, reply } = playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('I could not start **A YouTube Song**');
  });

  it('answers when joining the voice channel fails', async () => {
    const { context, logger } = fakeContext({
      join: vi.fn().mockRejectedValue(new Error('gateway timeout')),
    });
    const { interaction, reply } = playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    expect(replyContent(reply)).toContain('could not join your voice channel');
    expect(logger.error).toHaveBeenCalled();
  });

  it('keeps the track free of any media URL', async () => {
    const { context, player } = contextWithPlayer('guild-1', null);
    const { interaction } = playInteraction(VIDEO_URL);

    await play.execute(interaction, context);

    expect(JSON.stringify(player.current)).not.toContain('googlevideo');
    expect(player.current?.canonicalUrl).toBe(VIDEO_URL);
  });
});
