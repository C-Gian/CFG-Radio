import type { AppConfig } from '../config/env.js';
import type { Logger } from '../logger.js';
import type { PlayerService } from '../player/player-service.js';
import type { YouTubeMetadataProvider } from '../youtube/metadata.js';
import type { YouTubePlaylistProvider } from '../youtube/playlist.js';

/**
 * Everything a command handler is allowed to reach for.
 *
 * Passing it explicitly keeps the handlers free of module level singletons and
 * trivial to exercise in tests.
 */
export interface CommandContext {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly players: PlayerService;
  readonly youtube: YouTubeMetadataProvider & YouTubePlaylistProvider;
}
