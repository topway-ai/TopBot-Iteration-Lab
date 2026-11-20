# Local Qwen Video Uploads

In a direct chat using `qwen35-4b-uncensored` on a loopback OpenAI-compatible endpoint,
attach one playable clip of at most 60 seconds and ask a question about its visuals.
TopBot samples the start, middle and near the end. If Qwen reports insufficient
visual evidence, the same turn makes at most one denser pass with up to seven frames.
The review uses silent stills, not audio or a continuous video stream.

The local video turn does not run tools. Rooms, mixed image/video turns and other
models retain the existing attachment pipeline. No new model or permission setting
is required; llama.cpp must already be running with the vision projector.
On desktop, the selected local model advertises video review so the renderer
uploads the selected clip to the private attachment store instead of sending its
original path. Other models retain their current attachment intake behavior.

## Regression Test

Run with the directory containing FFmpeg and FFprobe set explicitly:

```powershell
$env:OMB_VERIFY_FFMPEG_DIR = Split-Path -Parent (Get-Command ffmpeg).Source
pnpm exec vitest run server/turn-video.test.ts server/drivers/local-qwen-video.test.ts server/local-qwen-video.e2e.test.ts --maxWorkers=1
```

The fixture uploads a generated MP4. It checks one three-frame pass for an obvious
detail, a three-frame pass followed by seven for a brief color change, and the
unchanged four-frame streaming request for a different model. It does not contact
cloud providers or use their credentials.

For live qualification set `OMB_QWEN_VIDEO_LLAMA_URL` to the explicit loopback
llama.cpp `/v1` URL. To test the renderer, set `OMB_QWEN_VIDEO_UI` to a built UI
directory and `OMB_CDP_CHROME` to an installed Chrome or Chrome Headless Shell.
An optional `OMB_QWEN_VIDEO_EVIDENCE` directory retains the receipt and screenshot.
On a slow machine, run `node scripts/bundle-server.mjs` first and set
`OMB_VERIFY_BUNDLED_SERVER=1` to start the bundled server in the disposable fixture.
