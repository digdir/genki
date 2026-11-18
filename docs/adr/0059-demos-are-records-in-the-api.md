# 0059 Demos are records in the API

Status: proposed, 2026-11-17 (records, seeding, library routes, recorder upload routes and the console library built)

Left: recording from the console and the recorder container, share links and a public player, the demo editor and the demo assistant, publishing and archiving, an Entra group for viewers who are not operators, and speech through the governed path.

## Context

Narrated demos of genki are recorded by `scripts/demo.ts` from `demos/*.yaml`, by hand or in the hand-run `demos` workflow, and land as workflow artifacts that only people with GitHub access can find. People who present genki need a library they can play and download from, and the recording should later move into the platform.

## Decision

- **A demo is a versioned configuration entry** of kind `demo` in the platform scope, with the shape of `demos/*.yaml`: `title`, `description`, `audience` (`municipality`, `state-agency`, `internal`), `language`, `voice`, `viewport`, `app` (`portal`, `console`, `workspace`) and `path`, `signedIn`, `ready` and `steps`. `app` plus `path` replaces the absolute `start` URL, so a demo is not tied to one host; a file with `start` is read as the app named by the host's first label and the rest of the URL as the path. Each step's `do` commands must start with one of the recorder's browser commands, the same allowlist as `parseDemo`.
- **A recording is a configuration entry** of kind `demo-recording`, a new version at each change: `demo`, `demoVersion`, `genkiVersion`, `status` (`running`, `recorded`, `failed`), `steps`, `narrated`, `voice`, timestamps, `seconds`, `files` and `failure` (`step`, `command`, `message`). Its files are blobs under `demos/recordings/{id}/` in the platform tenant: `demo.mp4`, `demo.srt`, `poster.jpg` and `failed-step-{n}.png`, each with its own size limit.
- **Seeding.** At start the API reads `demos/*.yaml` (shipped in the image through `docker/runtime-assets`) and saves each as a demo by `platform:seed`, a new version only when the file changed. A demo last saved by someone else is kept.
- **Viewer and editor.** `GET /operator/demos`, `GET /operator/demos/{id}`, `GET /operator/recordings/{id}` and its files need the demo viewer role; `PUT /operator/demos/{id}` (JSON or the YAML of a file, a change reason, optional `if-match`) needs the demo editor role and is audited as `platform.demo.save`. Today an operator holds both roles and nobody else does; the check lives in `mayViewDemos` and `mayEditDemos` in `apps/api/src/demos.ts`.
- **The recorder.** `POST /recorder/demos/{id}/recordings`, `PUT /recorder/recordings/{id}/files/{name}` and `POST /recorder/recordings/{id}/finish` take only the key whose SHA-256 hex digest is set in `DEMO_RECORDER_KEY_SHA256`, sent in `x-recorder-key` and compared in constant time. Without the setting every recorder call is refused. The recorder acts as the platform principal `recorder`; starting and finishing a recording are audited as `platform.demo.recording.start` and `platform.demo.recording.finish`. A recording takes files only while it runs, and finishes as recorded only with its video.
- **Out of date** is a recording made on another genki version than the API runs (`APP_VERSION`); the library returns that version so the console can show it.

## Why

Configuration entries are versioned, audited by `by` and `reason`, stored in Postgres without a migration, and already hold other platform records, such as the state register (ADR 0058). The recorder key is the smallest identity that lets the hand-run workflow fill the library before the recorder container exists, and it reaches only the three recorder routes: it is not an API key, carries no tenant rights and cannot read the library. A separate header keeps it out of the bearer-token path and the lockdown rules for people and API keys.

Rejected: Entra app roles `GenAI.DemoViewer` and `GenAI.DemoEditor` on the console client, because operator login goes through Ansattporten groups (ADR 0035) and no Entra app roles reach the API today; a new table, since the records are few and versioned; and a share link now, which needs its own expiry, revocation and public route.

## Consequences

- The `demos` workflow can upload its results: start a recording with the key, upload `demo.mp4`, `demo.srt` and any `failed-step-{n}.png`, and finish it. That step, and `DEMO_RECORDER_KEY_SHA256` in the API's environment in genki-test, are not built.
- Sellers and presenters who are not operators cannot open the library yet. Giving them the viewer role needs a mark from an Entra group in the verifier, as ADR 0035 does for operators.
- The console fetches a whole video into the browser before it plays; range requests and short-lived links come with the public player.
- When the recorder runs in its own container, it keeps these routes and moves from the key to a workload identity.
