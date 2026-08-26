# AGENTS.md — CFG Radio

Permanent working rules for any AI agent (Codex, Claude Code, …) operating on this repository.
They apply to **every** task, not just the current one.

## Project

CFG Radio is a **private, single-guild Discord music bot**.

Stack: Node.js 24 LTS · TypeScript (strict, ESM) · discord.js · later `@discordjs/voice`, FFmpeg,
yt-dlp behind a provider abstraction (SoundCloud as future fallback).

Deliberately **not** used: database, Redis, Lavalink, microservices. The queue is in memory.
Docker comes later.

## Secrets — non-negotiable

- **Never read, open, print, copy or modify `.env`.** No `cat` / `Get-Content` / `type` / editor
  on that file, not even "just to check a variable name".
- To learn the configuration, read **`.env.example`**.
- Never print the value of an environment variable, and never echo a secret into output, diffs,
  logs, tests, documentation or commits.
- Never commit `.env` (or any `.env.*` other than `.env.example`). Verify `.env` is git-ignored
  **before** any `git add`.
- Logs must never contain the Discord token. `src/logger.ts` scrubs values registered through
  `registerSecret()` — register any new credential there.
- Never regenerate or rotate the Discord token.
- Running the app (which loads `.env` through dotenv at runtime) is fine — reading the file
  yourself is not.

## Definition of done

A task is complete only when all of these pass:

```
npm run check   # format:check + lint + typecheck + test + build
```

Never declare a task done while lint, typecheck, tests or build are failing, and never relax
strictness (TS or ESLint) just to make an error disappear — fix the code instead.

## Code rules

- **TypeScript `strict: true`**, ESM, `.js` extensions on relative imports (NodeNext resolution).
- Prefer **small, coherent changes**. Do not refactor or restructure unrelated code.
- **No over-engineering.** This is a low-traffic private bot: pick the simplest clean solution.
- Do not change the architecture without a **real blocker**, and say so explicitly when you do.
- Do not add dependencies unless genuinely necessary; justify any new one.
- **No provider logic inside Discord command handlers.** Handlers translate an interaction into a
  call to domain code and back — nothing else.
- Slash commands are registered **explicitly** via `npm run register`, never implicitly at startup.
- Future external processes (yt-dlp, FFmpeg) **must** have timeouts and guaranteed cleanup of
  child processes, streams and temp files.
- Errors in an interaction handler must never crash the process.

## Scope

- Implement **only** the requested milestone, plus what is strictly necessary for it to work.
- Do not create empty folders or placeholder modules for future milestones.

## Hard prohibitions

No CAPTCHA solving, proxy rotation, fingerprint spoofing, geo-restriction bypass, or any other
anti-bot evasion technique — in code, dependencies or documentation.

## Layout

```
src/
  audio/
    ffmpeg.ts                FFmpeg child process abstraction (Ogg/Opus on stdout) + probe
    test-tone.ts             path/validation of the synthetic smoke-test asset
  config/env.ts              env validation -> typed AppConfig (throws ConfigError, never logs values)
  discord/
    client.ts                Discord client factory + event wiring
    command.ts               Command contract, registry, REST serialisation
    context.ts               CommandContext handed to every command handler
    interaction-handler.ts   interaction routing + error handling
    commands/                one file per slash command
  voice/
    session.ts               VoiceConnection + AudioPlayer + current FFmpeg pipeline
    session-manager.ts       one session per guild, cleanup entrypoint
    policy.ts                pure "can I play here?" decision logic
  logger.ts                  leveled logger with secret redaction
  index.ts                   runtime entrypoint (login, graceful shutdown)
  register-commands.ts       one-off guild slash command registration
  diagnostics-voice.ts       npm run diagnostics:voice
tools/                       maintenance scripts (test tone generation)
assets/                      synthetic smoke-test audio only (see assets/README.md)
tests/                       Vitest, pure logic only — no network, no real token, no .env
```

## Audio / voice rules

- FFmpeg is a **system dependency**, spawned as a controlled child process. Do not
  switch to `ffmpeg-static` or a native Opus binding without a real blocker: FFmpeg's
  libopus already produces the Ogg/Opus 48 kHz stereo stream Discord wants.
- Every spawned process must be owned by something that kills it: `stop()`/`destroy()`
  are idempotent and must leave no zombie FFmpeg behind.
- A dying FFmpeg, a failed voice handshake or an audio player error must never crash
  the process — log, clean up, tell the user.
- `assets/` holds synthetic smoke-test audio only. Never commit copyrighted media.

## Tests

Tests must not use the real token, hit the network, connect to Discord, or read `.env`.
Cover pure logic (config validation, command registry, interaction routing, logging).
