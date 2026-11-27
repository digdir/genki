# Demos

Each file here is a narrated demo of genki: a title, a voice, a start page and steps. A step is one line the voice reads and the clicks shown while it is read. `scripts/demo.ts` turns a file into an mp4 with voice and subtitles in `demos/out/<name>/`.

```yaml
title: En rask tur i GenKI-portalen
language: nb-NO
voice: nb-NO-PernilleNeural
viewport: [1920, 1080]
start: https://portal.genki-test.digdir.cloud
steps:
  - say: Fellestjenestene er klare fra første dag.
    do:
      - [find, role, link, click, --name, Fellestjenester]
    hold: 1
```

`do` takes [agent-browser](https://github.com/vercel-labs/agent-browser) commands: `find`, `click`, `fill`, `type`, `press`, `hover`, `select`, `scroll`, `wait`, `open` and a few more. Commands that read the page's storage or run code, such as `eval`, `storage` and `cookies`, are refused, and so is any flag but `--name`, `--exact`, `--text`, `--timeout`, `--load` and `--url`. A click or fill is tried again for up to 15 seconds while the screen loads; after that the recording stops with the step, its line and the command, and leaves `failed-step-<n>.png` (`failed-step-0.png` when the start page never shows `ready`). A browser command that hangs is stopped after three minutes. `hold` is the seconds to wait after the line has been read (0.6 by default). The voice starts once the last command that changes the page (a click, `open`, `wait` and the like) has finished and the page has settled; a `hover` after it runs while the line is read. Before a click, hover or fill, the pointer glides to the element, scrolling smoothly when it is off screen, and pauses briefly, so it never jumps. Without `viewport` a demo is recorded at 1920 x 1080.

A demo is cut like a launch film. `intro` and `outro` add a title card before it and a closing card after it (`title`, and optionally `subtitle` and `presenter`), with the Digdir emblem. `chapter` on a step starts a chapter, shown as a title at the top of the film. `focus` on a step hints at what to zoom to while the line is read: `[role, table]`, `[role, heading, Statistikk]`, `[text, Hvor data behandles]`, `[label, Formål]` or `[css, main table]`; a focus the recorder cannot find is left out. How a film is made from this is under [How a film is made](#how-a-film-is-made).

```yaml
intro:
  title: Genki
  subtitle: Generativ KI for offentlige virksomheter
  presenter: Ola Nordmann, Digdir
steps:
  - say: Katalogen viser hvor dataene behandles.
    chapter: En rask tur
    do:
      - [find, role, link, click, --name, Katalog]
    focus: [text, Hvor data behandles]
```

`signedIn: true` signs the portal, workspace and console in with the key in `DEMO_API_KEY`, the way the smoke test does: agent-browser answers each app's `/auth/me` as signed in to the demo tenant (the console as an operator) and sends the key as a bearer token only to the apps' own origins, never to the login issuer or anyone else. Without the key that demo is skipped. `ready` is a text on the start page to wait for before recording starts.

## How a film is made

The recorder captures, it does not film. It records the app at one and a half times the pixels without a pointer and in the dark colour scheme, so the portal and the console look the same, and writes `events.json` next to it: for each step when it started, when it left the page, when the page was ready and the voice started, where the pointer moved and clicked, the boxes of the page's headings, tables and sections, and the spoken words with their times (Azure Speech fast transcription of each clip, kept as `<clip>.words.json` in `demos/out/.voice`).

An AI director then writes the edit decision list, `edl.json`: the shots (page loading is always cut out, page changes pass through the window's dark background, so two pages never show at once), camera moves tied to the word they serve, callouts, chapters, cards and the pace (`lead` and `tail` around each line). It sees the script with the word timings, the event log and a keyframe of every step. Its edit is checked against a rubric, by rules in `scripts/demo-edl.ts` and by the model looking at proof frames rendered around every camera move and cut; it revises until the review passes or three rounds have gone. Each round's edit and critique are kept as `edl-round-<n>.json` and `review-round-<n>.json`. The director runs when `DEMO_AUDIO_ENDPOINT` is set and someone has approved a cost cap for the recording (it uses `DEMO_DIRECTOR_MODEL`, `gpt-5.5` by default, on the same resource); it estimates its cost before it starts and makes a plain edit instead when that is more than what is left of the cap. Without it, a plain edit is made from the `focus` and `chapter` hints, and `DEMO_DIRECTOR=off` asks for that.

The renderer makes the film from the capture and the edit list alone, so the same `edl.json` always gives the same film: the app in a floating window that fills almost the whole width, on a dark Digdir backdrop, a spring camera with motion blur, a drawn pointer that glides, ripples on a click and hides when idle, a slight push in on clicks, captions, chapter titles and cards in Inter. It renders 60 frames a second at 1920 x 1080 to H.264. To render again from a kept capture, for example after editing `edl.json` by hand:

```sh
node scripts/demo.ts film demos/out/<demo>
```

In the console, Demoer has a studio for a recorded film: the edit list as a timeline, the film beside it, and a box for an instruction to the director, such as "hold longer on the model table". The instruction is queued like a recording, with a reason and an approved cost, and the recorder revises `edl.json` and renders the film again from the same capture and the same voice clips, which the first recording keeps as `voice-<hash>.mp3` with their word timings.

## What a film may cost

The recorder makes a priced model call (the model voice and its hear-back, word timings, the director and an edit) only for a recording someone has approved a cost cap for. In the console the person who starts a recording sees what it is expected to cost, at most 25 USD, and ticks to approve it; a demo with a model voice, and every edit, cannot be queued without that. The recorder checks the worst case of each line, word timing and director call against what is left of the cap before it makes it, stops when the cap would be passed, and reports what it spent on the recording, where the console shows it. Without approval an Azure Speech voice still reads the lines, a model voice is left out unless its clips are cached, words are timed by estimate and the cut is plain. A local run approves with `DEMO_COST_CAP_USD`.

## Record one

You need `agent-browser`, `ffmpeg` and the Azure CLI, logged in with `az login` to a subscription that has an Azure AI Speech resource (an AI Services resource works). The voice is called with your Entra token; no key is stored.

```sh
export SPEECH_RESOURCE=<resource name> SPEECH_RESOURCE_GROUP=<resource group> SPEECH_SUBSCRIPTION=<subscription id>
node scripts/demo.ts demos/portal-tour.yaml
node scripts/demo.ts check                 # validate every demo and estimate its length
node scripts/demo.ts record --only playground
node scripts/demo.ts record --silent demos/portal-tour.yaml   # subtitles only, no voice
```

Voices come from providers, listed in `packages/contracts/src/demo-voices.ts` and in the console: Azure Speech's neural voices, the model voice `cedar` (Azure OpenAI `gpt-audio-1.5`), and ElevenLabs, which is not built yet; its key will live in Key Vault and reach only the recorder, never a demo or this repository.

`voice: cedar` reads the lines with the model voice the lab's Friday Win videos use: `gpt-audio-1.5` on Azure OpenAI, told to read word for word in natural eastern Norwegian bokmål. Each line is heard back with Azure Speech and read again, up to four times, until the transcript matches the text within two words (or five percent of a long line), and the best take is kept with its transcript in `demos/out/.voice/<clip>.json`. It also needs `ffmpeg`, an approved cap (`DEMO_COST_CAP_USD` for a local run) and `DEMO_AUDIO_ENDPOINT`, the https endpoint of the resource with the `gpt-audio-1.5` deployment, which your Entra login must be allowed to call (Cognitive Services OpenAI User):

```sh
export DEMO_AUDIO_ENDPOINT=https://<resource>.cognitiveservices.azure.com
```

A line costs well under one krone; the voice run prints the tokens it used and what it spent of the approved cap.

Without the speech settings, and without a saved clip for every line, a demo is recorded with subtitles only.

To fill the console's library, also set `DEMO_API_URL` and `DEMO_RECORDER_KEY`: the recording is then started, followed step by step and finished in the API. `node scripts/demo.ts recording <id>` records a recording queued from the console. In genki-test the `demo-recorder` workflow does that every five minutes: `node scripts/demo.ts queued` lists the queue to `demos/out/queued.json`, `voice --queued` voices its lines and `recording --queued` records each in turn.

Each line is sent to the voice once and cached in `demos/out/.voice`, so recording again only pays for changed lines. A recording drives genki-test like a person would, so record against the test environment only. Of the demos, only `playground` asks genki's models a question; the recorder's own model calls are under [What a film may cost](#what-a-film-may-cost).

See `docs/design/demos/brief.md` for where this is going.
