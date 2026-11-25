# Demos

Each file here is a narrated demo of genki: a title, a voice, a start page and steps. A step is one line the voice reads and the clicks shown while it is read. `scripts/demo.ts` turns a file into an mp4 with voice and subtitles in `demos/out/<name>/`.

```yaml
title: En rask tur i GenKI-portalen
language: nb-NO
voice: nb-NO-PernilleNeural
viewport: [1280, 720]
start: https://portal.genki-test.digdir.cloud
steps:
  - say: Fellestjenestene er klare fra første dag.
    do:
      - [find, role, link, click, --name, Fellestjenester]
    hold: 1
```

`do` takes [agent-browser](https://github.com/vercel-labs/agent-browser) commands: `find`, `click`, `fill`, `type`, `press`, `hover`, `select`, `scroll`, `wait`, `open` and a few more. Commands that read the page's storage or run code, such as `eval`, `storage` and `cookies`, are refused, and so is any flag but `--name`, `--exact`, `--text`, `--timeout`, `--load` and `--url`. A click or fill is tried again for up to 15 seconds while the screen loads; after that the recording stops with the step, its line and the command, and leaves `failed-step-<n>.png` (`failed-step-0.png` when the start page never shows `ready`). A browser command that hangs is stopped after three minutes. `hold` is the seconds to wait after the line has been read (0.6 by default).

`signedIn: true` opens the portal and console with the key in `DEMO_API_KEY`, the way the smoke test does; without the key that demo is skipped. `ready` is a text on the start page to wait for before recording starts.

## Record one

You need `agent-browser`, `ffmpeg` and the Azure CLI, logged in with `az login` to a subscription that has an Azure AI Speech resource (an AI Services resource works). The voice is called with your Entra token; no key is stored.

```sh
export SPEECH_RESOURCE=<resource name> SPEECH_RESOURCE_GROUP=<resource group> SPEECH_SUBSCRIPTION=<subscription id>
node scripts/demo.ts demos/portal-tour.yaml
node scripts/demo.ts check                 # validate every demo and estimate its length
node scripts/demo.ts record --only playground
node scripts/demo.ts record --silent demos/portal-tour.yaml   # subtitles only, no voice
```

Without the speech settings, and without a saved clip for every line, a demo is recorded with subtitles only.

To fill the console's library, also set `DEMO_API_URL` and `DEMO_RECORDER_KEY`: the recording is then started, followed step by step and finished in the API. `node scripts/demo.ts recording <id>` records a recording queued from the console. In genki-test the `demo-recorder` workflow does that every five minutes: `node scripts/demo.ts queued` lists the queue to `demos/out/queued.json`, `voice --queued` voices its lines and `recording --queued` records each in turn.

Each line is sent to the voice once and cached in `demos/out/.voice`, so recording again only pays for changed lines. A recording drives genki-test like a person would, so record against the test environment only. Only `playground` sends a question to a model.

See `docs/design/demos/brief.md` for where this is going.
