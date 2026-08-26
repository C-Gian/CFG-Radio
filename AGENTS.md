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
    local-catalog.ts         synthetic asset catalog + local Track -> PlayableSource
    track-resolver.ts        dispatches a Track to the resolver of its source
  config/env.ts              env validation -> typed AppConfig (throws ConfigError, never logs values)
  discord/
    client.ts                Discord client factory + event wiring
    command.ts               Command contract, registry, REST serialisation
    context.ts               CommandContext handed to every command handler
    error-messages.ts        provider failure codes -> short user answers
    guild-access.ts          shared guild + voice-channel checks for the handlers
    play-flow.ts             shared /play + /playlocal preflight and answers
    interaction-handler.ts   interaction routing + error handling
    track-format.ts          pure /queue and /nowplaying message rendering
    commands/                one file per slash command
  player/
    track.ts                 Track: provider-agnostic logical identity of a song
    queue.ts                 pure FIFO TrackQueue
    guild-player.ts          orchestration: queue, current track, auto-next, controls
    provider-error.ts        stable, provider-agnostic failure codes
    player-service.ts        one GuildPlayer per guild, tied to its voice session
    transport.ts             PlaybackTransport / PlayableSource / TrackResolver contracts
  youtube/
    ytdlp.ts                 the ONLY place that spawns yt-dlp (timeout, kill, classification)
    url.ts                   pure input classification (single videos only)
    metadata.ts              yt-dlp JSON -> YouTubeMetadata -> Track
    playback.ts              late resolution: Track -> direct media URL + headers
  voice/
    session.ts               VoiceConnection + AudioPlayer + FFmpeg (implements the transport)
    session-manager.ts       one session per guild, cleanup entrypoint
    policy.ts                pure voice-channel decisions (play / control)
  logger.ts                  leveled logger with secret redaction
  index.ts                   runtime entrypoint (login, graceful shutdown)
  register-commands.ts       one-off guild slash command registration
  diagnostics-voice.ts       npm run diagnostics:voice
  diagnostics-ytdlp.ts       npm run diagnostics:ytdlp
tools/                       maintenance scripts (synthetic asset generation)
assets/                      synthetic smoke-test audio only (see assets/README.md)
tests/                       Vitest, pure logic only — no network, no real token, no .env
tests/integration/           real yt-dlp/YouTube; excluded from `npm test` (npm run test:integration)
```

Layering, from the command down: **handler → GuildPlayer → TrackResolver → PlaybackTransport
(VoiceSession) → FFmpeg**. Keep it that way:

- A `Track` is a logical identity. Never put a file path, URL, Discord object, voice connection
  or audio resource in it.
- The queue and the player must stay free of discord.js, `@discordjs/voice`, FFmpeg, the
  filesystem and the network — that is what makes them testable.
- Turning a `Track` into something playable is the resolver's job. The player must never learn
  how FFmpeg is spawned.
- Every state changing player operation goes through the internal serialisation chain, and a
  stale track end must never trigger an auto-next: `/stop` and `/skip` clear the current track
  _before_ stopping the transport.

## Provider rules

- **Only `src/youtube/ytdlp.ts` spawns yt-dlp.** Arguments are always an array, never a shell
  string, and never built by concatenating user input.
- Always pass `--no-js-runtimes --js-runtimes node`: yt-dlp prefers Deno when it is enabled, and
  CFG Radio pins the runtime to the Node it already ships.
- Providers raise a classified `ProviderError`; the player and the handlers never read yt-dlp
  stderr, and users never see it.
- **Late resolution is mandatory.** A queued track holds identity only. Signed media URLs are
  resolved when playback starts, live in the `PlayableSource`, and are never stored, cached or
  persisted.
- The single exception is the _immediate_ start: `/play` may hand `enqueue()` the source that
  came out of the very same extraction, and the player uses it only when the track starts right
  away and the offer is still fresh. A track that gets queued drops the offer and is resolved
  late like everything else. Never widen this into a media-URL cache.
- Never add cookies, an account, a browser profile, a proxy or a PO-token workaround. If YouTube
  refuses, classify the failure and fail cleanly.
- Never download media to disk: FFmpeg streams the resolved URL.

## Cancellation and retries

- Every playback attempt owns an `AbortController`. `/skip`, `/stop`, `/disconnect`,
  `destroy()` and shutdown abort it, which kills the yt-dlp child immediately instead of
  waiting for its 30s timeout. The attempt epoch stays as the second line of defence
  against a late result; the signal stops the work that produces it.
- The signal belongs to **one attempt in one guild**. Never share a controller between
  guilds, tracks or the whole process.
- A command that was cancelled before its body reached the serialisation chain must not
  start anything: both `enqueue` and `enqueueMany` compare the epoch they were scheduled
  with against the current one.
- A deliberate cancellation is `ProviderError` code `cancelled`. It is never reported as a
  timeout or an extractor fault, and never triggers a SoundCloud fallback.
- **Retry policy: no automatic retries**, with exactly one exception. A source that was
  already resolved when the command ran (the immediate-start optimisation) may have gone
  stale, so a pre-start failure on such a source earns exactly one fresh resolution. Every
  other failure - `unavailable`, `login_required`, `geo_restricted`, `unsupported`,
  `rate_limited`, `timeout`, `extractor_failed`, a low-confidence fallback, or any
  post-start death - is reported and the queue moves on. Retrying those wastes time, risks
  duplicate audio or makes rate limiting worse.

## Logging rules

- `redactUrls()` strips the query string of every URL before it reaches a log line: signed
  googlevideo and SoundCloud CDN links carry their signature there, and FFmpeg prints them
  verbatim on a 403. Host and path survive so failures stay debuggable.
- Never log a direct media URL, a cookie, an authorization header or a token. The token is
  additionally scrubbed through `registerSecret()`.

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
