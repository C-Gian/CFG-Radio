# assets/

## `test-tone.opus`

**Smoke-test asset only. Not music, not a demo track, not user facing content.**

An 8 second synthetic arpeggio (A4 → C#5 → E5 → A5, two seconds per note) with a
short fade in/out, encoded as Ogg/Opus 48 kHz stereo — exactly the format Discord
voice consumes.

It exists for one reason: `/playlocal` uses it to prove that the
`Discord → voice connection → AudioPlayer → FFmpeg → local file` pipeline really
carries sound. It is generated entirely by FFmpeg's `sine` source, so there is no
copyrighted material involved and the output is byte-for-byte reproducible.

Regenerate it with:

```
npm run assets:tone
```

The generator lives in `tools/generate-test-tone.ts` and needs a system FFmpeg
built with libopus (`npm run diagnostics:voice` verifies that).
