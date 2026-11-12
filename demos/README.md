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

`do` takes [agent-browser](https://github.com/vercel-labs/agent-browser) commands. `hold` is the seconds to wait after the line has been read (0.6 by default).

## Record one

You need `agent-browser`, `ffmpeg` and the Azure CLI, logged in with `az login` to a subscription that has an Azure AI Speech resource (an AI Services resource works). The voice is called with your Entra token; no key is stored.

```sh
export SPEECH_RESOURCE=<resource name> SPEECH_RESOURCE_GROUP=<resource group> SPEECH_SUBSCRIPTION=<subscription id>
node scripts/demo.ts demos/portal-tour.yaml
```

Each line is sent to the voice once and cached in `demos/out/.voice`, so recording again only pays for changed lines. A recording drives genki-test like a person would, so record against the test environment only.

See `docs/design/demos/brief.md` for where this is going.
