# Demos

Brief for a demo maker and a demo library in the console. It is a proposal and can be reworked. Draw with the console shell, Designsystemet components and the existing tone. All UI text in bokmål, with no em-dashes.

## The problem

- People who present Genki, such as sellers and the platform team, show it live or with screenshots. A live demo breaks when the test environment is slow or a screen has changed, and screenshots go stale after a release.
- There is no shared place to find a demo of a given feature, so each person builds their own.
- A good narrated video takes hours by hand. The spike in `scripts/demo.ts` shows that a short YAML file can produce one in about a minute: agent-browser clicks through genki-test, Azure AI Speech reads the narration, and ffmpeg joins video, voice and subtitles.

The goal is a library of short narrated demos that people can play or download when they are out selling, and that never shows an old version of Genki.

## Built in, with the writer as a service

The demo maker is a built-in console feature, not a service in the portal catalogue.

- Its users are the platform team and the people who present Genki, not an organisation's end users.
- It drives Genki's own screens with a browser, a voice and ffmpeg. A service gets models, datasets and tools, and a browser recorder is none of these.
- The AI part follows the builder assistant (ADR 0020): a service definition owned by the platform tenant (`demo-writer`), run through the kernel on the model its definition grants, with a token budget, an audit trail and its own test set. It only proposes a demo; a person edits and records it.

The demo itself is a YAML file that can be read and changed through the API, so the console screens are a simple layer on top, and a demo can be written by hand or by a coding agent.

## Words

| Norwegian UI  | English      | Meaning                                                         |
| ------------- | ------------ | --------------------------------------------------------------- |
| Demo          | demo         | A YAML file: title, voice, start page and steps                 |
| Steg          | step         | One line of narration and the clicks shown while it is read     |
| Opptak        | recording    | One run of a demo: video, voice and subtitles, for one version  |
| Demobibliotek | demo library | The recordings people can play, download and share              |
| Utdatert      | out of date  | The latest recording is older than the running version of Genki |
| Feilet        | failed       | A step could not be carried out, usually a changed screen       |

## How it works

1. **Write.** Describe what to show in a chat («Vis hvordan en kommune setter opp en tjeneste med Altinn-innlogging»). `demo-writer` reads the docs, the design briefs and the screens' link names, and proposes a demo. Edit it as a form or as YAML.
2. **Try.** Record one step or the whole demo. The voice is cached per voice and line, so trying again costs only the changed lines.
3. **Publish.** The demo enters the library with its first recording.
4. **Keep current.** After each release to genki-test every published demo is recorded again. A demo whose step fails is marked «Feilet» with the step and a screenshot, and the library keeps showing the last good recording, marked «Utdatert».

## Screens

### Console, Plattform → Demoer

1. **Demobibliotek.** Cards with title, length, the Genki version recorded, the date, and a still. Filter by area (Portal, Arbeidsflate, Konsoll) and audience (kommune, statlig virksomhet, intern). Each card: «Spill av», «Last ned» (mp4 with subtitles), «Kopier lenke». States: Klar, Utdatert, Feilet.
2. **Demo, detail.** The video with the subtitles beside it as a clickable step list, the recording history, who published it and when, and «Ta opp på nytt».
3. **Ny demo.** The chat with `demo-writer` on the left and the proposed steps on the right, each with its narration, its clicks and «Prøv dette steget». «Vis YAML» toggles the raw file.
4. **Opptak pågår.** Progress per step, the current screenshot, and a cancel button. Long work runs as a job, never in the request.
5. **Feilet opptak.** The failed step, what the recorder looked for, a screenshot of what it found, and «Rediger steget».
6. **Innstillinger for demoer.** Default voice and a sample to listen to, viewport, the test organisation and login used for recording, and how long recordings are kept.

States to show: an empty library, a demo being recorded, a demo marked «Utdatert», a demo marked «Feilet», and a library filtered to one audience.

## Recording

- **Where it runs.** First as a GitHub workflow in this repository, triggered by hand and after each deploy to genki-test, with the demos in `demos/`. Later as a durable job (ADR 0041) behind the console screens. Worker jobs are Kent's area; agree the job with him before building it.
- **Who it logs in as.** A demo organisation of its own in genki-test with made-up services and data, never a real organisation's. Under the genki-test lockdown (ADR 0033) a TestID login can only read, so a demo that shows a change needs a recording identity with write rights in that one organisation.
- **The voice.** Azure AI Speech, `nb-NO-PernilleNeural` today, called with an Entra token and no stored key. In the platform it is called as a provider API through a descriptor (ADR 0049), like any other. A local engine (VoiceStudio) is being compared by ear before anything is chosen.
- **What is stored.** The YAML, each recording's mp4 and srt, the Genki version and the commit. No personal data: the demo organisation has none, and the recording identity is a test user.

## Open questions

- **Who sees the library.** The console is for operators. Proposed: a read-only role that sees only Demoer, given to sellers, rather than a separate site.
- **Organisations' own demos.** Should an organisation later make demos of its own services in the portal? If so, it needs the tenant boundary and rights, and is a separate step.
- **Sharing outside Digdir.** A link opens only with a Digdir login. A downloaded mp4 can be shared freely, so the demo organisation must contain nothing that cannot be shown.
- **Languages.** Bokmål and English, like the rest of the platform, with one voice per language.

## Phases

1. **The recorder in the repository.** `scripts/demo.ts`, `demos/*.yaml`, a workflow that records after each deploy and keeps the mp4s as artifacts. Make three or four real demos with the sellers to learn what a good one looks like.
2. **The library.** Screens 1, 2 and 6, reading the recordings the workflow produced.
3. **The writer.** `demo-writer` as a platform-tenant service with its test set, and screens 3 to 5, with recording as a job.

## Example data

Made up, no real people.

- Demo organisation «Eksempel kommune» in genki-test, with the services «Byggesak-veileder» and «Klarspråk for saksbehandlere».
- Demos: «Rundtur i portalen» (39 s, Portal, intern, Klar), «Sett opp en tjeneste med Altinn-innlogging» (2 min 10 s, Portal, kommune, Utdatert), «Følg en kjøring i sporingen» (1 min 25 s, Konsoll, intern, Feilet at step 4 «Åpne kjøringen»).

## Delivery

One mock per screen in `mocks/` next to this brief, drawn as a Design artifact in Claude and exported here.
