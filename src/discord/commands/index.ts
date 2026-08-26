import type { Command } from '../command.js';
import { disconnect } from './disconnect.js';
import { nowPlaying } from './nowplaying.js';
import { pause } from './pause.js';
import { play } from './play.js';
import { ping } from './ping.js';
import { playLocal } from './play-local.js';
import { queue } from './queue.js';
import { resume } from './resume.js';
import { skip } from './skip.js';
import { stop } from './stop.js';
import { volume } from './volume.js';
import { shuffle } from './shuffle.js';
import { loop } from './loop.js';

/** Every slash command shipped by the bot. */
export const commands: readonly Command[] = [
  ping,
  play,
  playLocal,
  pause,
  resume,
  skip,
  stop,
  queue,
  nowPlaying,
  volume,
  shuffle,
  loop,
  disconnect,
];
