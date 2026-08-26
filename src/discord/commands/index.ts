import type { Command } from '../command.js';
import { ping } from './ping.js';

/** Every slash command shipped by the bot. */
export const commands: readonly Command[] = [ping];
