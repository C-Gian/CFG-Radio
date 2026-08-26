# Deploying CFG Radio on Quaxly

Everything here targets the managed Pterodactyl-style panel with the
`ghcr.io/ptero-eggs/yolks:nodejs_24` image. No custom Docker image is involved:
the image already ships Node 24 and FFmpeg, and CFG Radio installs the one
thing it is missing (yt-dlp) itself, with a pinned version and a verified
checksum.

---

## 1. Create the server

| Setting | Value                                |
| ------- | ------------------------------------ |
| Image   | `ghcr.io/ptero-eggs/yolks:nodejs_24` |
| Node    | Germany / Germany-2                  |
| RAM     | 512 MB                               |
| CPU     | 100 %                                |
| Disk    | 1 GB                                 |

Measured footprint: ~131 MB peak RAM and ~158 MB disk, so both limits have
comfortable headroom.

## 2. Put the repository on the server

Use the panel's Git/GitHub integration if it offers one, otherwise from the
server console:

```
git clone https://github.com/C-Gian/CFG-Radio.git .
```

The repository must be **public** for this to work without credentials. If you
make it private, use the panel's GitHub integration or a deploy key — **never**
put a personal access token in the startup command, where it would be visible
in the panel and in logs.

## 3. Configure the environment variables

Panel → **Startup** → _Custom Environment Variables_.

| Variable                  | Required | Encrypt | Notes                                                     |
| ------------------------- | -------- | ------- | --------------------------------------------------------- |
| `DISCORD_TOKEN`           | **yes**  | **YES** | Tick _Encrypt this value and hide it after save_          |
| `DISCORD_CLIENT_ID`       | **yes**  | no      | Application ID                                            |
| `DISCORD_GUILD_ID`        | **yes**  | no      | The one guild the commands are registered to              |
| `LOG_LEVEL`               | no       | no      | `info` (default) · use `debug` only while troubleshooting |
| `DEFAULT_VOLUME`          | no       | no      | `100` by default, 0-100                                   |
| `IDLE_DISCONNECT_SECONDS` | no       | no      | `300` by default, 0 disables                              |
| `MAX_PLAYLIST_TRACKS`     | no       | no      | `100` by default                                          |
| `FFMPEG_PATH`             | no       | no      | Leave empty: the image provides `ffmpeg` on PATH          |
| `YTDLP_PATH`              | no       | no      | **Leave empty**: the bootstrap installs `./bin/yt-dlp`    |

Only `DISCORD_TOKEN` is a secret. Nothing else is sensitive, and the bot never
prints any of these values.

## 4. First deployment (and every update)

Run this in the panel console, with the server **stopped**:

```
npm ci && npm run build && node dist/ensure-runtime.js
```

That installs dependencies, compiles TypeScript to `dist/`, and downloads and
verifies the pinned yt-dlp into `./bin/yt-dlp`. It is the only step that needs
the network for setup, and it is **not** repeated on every restart.

Convenience alias: `npm run quaxly:deploy`.

## 5. Startup command (paste this exactly)

Panel → **Startup** → _Startup Command_:

```
node dist/ensure-runtime.js && exec node dist/index.js
```

Why this shape:

- `ensure-runtime` re-checks Node, FFmpeg and yt-dlp in a fraction of a second
  when everything is already in place, and silently re-downloads yt-dlp if the
  file ever disappears — so a restart is fast but never starts a broken bot.
- `exec` replaces the shell with Node, so **CFG Radio receives SIGTERM
  directly** when you press Stop. Its graceful shutdown (queues, FFmpeg,
  yt-dlp, voice connections, Discord client) then runs as designed.
- It deliberately does **not** run `git pull`, `npm install` or `npm run build`,
  so a crash-restart does not reinstall or rebuild anything.

Do not use `npm run quaxly:start` here: npm would sit between the panel and the
bot as an extra process and delay signal delivery. That script exists only for
local testing.

## 6. Verify the host before starting

With the server running (or from the console):

```
npm run diagnostics:quaxly
```

It checks platform and Node version, FFmpeg and libopus, a writable working
directory, the pinned yt-dlp, that yt-dlp really resolves the **Node**
JavaScript runtime, a **real** YouTube metadata + playable extraction, that
FFmpeg can read the resolved source, and a real SoundCloud search. It prints
`Ready for CFG Radio.` and exits 0 when everything passes.

Other useful checks, all runnable on the server:

```
npm run diagnostics:voice        # FFmpeg, libopus, local assets, opus re-encode
npm run diagnostics:ytdlp        # yt-dlp wrapper, JS runtime, error classification
npm run diagnostics:soundcloud   # SoundCloud search + playable resolution
npm run diagnostics:fallback     # end-to-end fallback decision
npm run diagnostics:hardening    # cancellation, timeouts, process cleanup, soak
```

## 7. Register the slash commands

Once, and again whenever a command changes:

```
node dist/register-commands.js
```

## 8. Start, logs, restart

- **Start**: the panel Start button, using the startup command above.
- **Logs**: the panel console captures stdout/stderr. Signed media URLs are
  redacted automatically; the Discord token never appears.
- **Restart**: the panel Restart button. This is the fast path — no install, no
  build, no download.

## 9. Updating

### Updating CFG Radio

1. Stop the server.
2. `git pull`
3. `npm ci && npm run build && node dist/ensure-runtime.js`
4. Start. If commands changed, run `node dist/register-commands.js`.

### Updating yt-dlp

yt-dlp is **never** self-updated at runtime (`yt-dlp -U` is not used), so a
deployment is always reproducible. To move to a newer release:

1. Take the new version and the `yt-dlp_linux` / `yt-dlp_linux_aarch64` lines
   from that release's `SHA2-256SUMS` file.
2. Update `YTDLP_VERSION` and both checksums in `src/setup/ytdlp-release.ts`.
3. Commit, `git pull` on the server, then re-run the deploy command. The
   bootstrap notices the checksum no longer matches and replaces the binary.

## 10. Rollback

```
git log --oneline          # find the previous good commit
git checkout <commit>
npm ci && npm run build && node dist/ensure-runtime.js
```

Then Start. Since `dist/` is rebuilt from the checked-out source and yt-dlp is
pinned per commit, a rollback restores the exact previous runtime.

## 11. Troubleshooting

| Symptom                                              | Cause and fix                                                                                   |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Invalid configuration: DISCORD_TOKEN is required`   | Variable missing or empty in the panel. Values are never printed, only names.                   |
| `FFmpeg is not runnable`                             | Wrong image, or `FFMPEG_PATH` set to something that does not exist. Leave it empty.             |
| `Checksum mismatch ... was NOT installed`            | The download was corrupted or tampered with. Nothing was installed. Re-run the deploy command.  |
| `No pinned yt-dlp build for linux/<arch>`            | The host is not x64/arm64. Install yt-dlp manually and set `YTDLP_PATH`.                        |
| `yt-dlp reports version X but Y was pinned`          | Something replaced `./bin/yt-dlp`. Delete it and re-run the deploy command.                     |
| Bot starts, `/play` answers but there is no sound    | Run `npm run diagnostics:quaxly`; it separates a YouTube extraction problem from an FFmpeg one. |
| `Cannot find module '/home/container/dist/index.js'` | The build never ran. Run the deploy command.                                                    |
| Everything works, then stops after a few days        | Check the panel for a suspension/renewal notice; CFG Radio itself has no expiry.                |

## 12. What is deliberately _not_ here

- No Dockerfile: the provided image already has Node 24 and FFmpeg.
- No HTTP server or health endpoint: CFG Radio only makes outbound
  connections, so the panel's TCP allocation stays unused.
- No process manager: the panel restarts the container, and the bot's own
  graceful shutdown handles SIGTERM.
