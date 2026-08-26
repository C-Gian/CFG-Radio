import type { Command } from '../command.js';
import { disconnect } from './disconnect.js';
import { ping } from './ping.js';
import { playLocal } from './play-local.js';

/** Every slash command shipped by the bot. */
export const commands: readonly Command[] = [ping, playLocal, disconnect];
