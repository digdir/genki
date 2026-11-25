# 0066 genki serves a cited remote PDF from allowed origins

Status: proposed, 2026-11-20 (built; `https://kudos.dfo.no` allowed in the test and prod parameter files, a file its record lists as over 50 MiB served as none, and a source address never framed by `createGenkiApi`, 2026-11-25)

Left: a PDF view for a host that calls genki with a bearer token, which cannot frame a route that needs its header, and a list of origins per dataset instead of one per environment ([#1008](https://github.com/digdir/genki/issues/1008)).

## Context

ADR 0065 opened `GET /api/datasets/{id}/documents/{doc}/file` for a cited document and kept one rule for a remote source: genki answers `302` to the source's own address and never fetches it. A source that forbids framing (`X-Frame-Options: SAMEORIGIN`, no CORS), as Kudos does, then cannot be shown in Dokumentvisning, so Kunnskapsassistenten has read those PDFs through its own server. A hosted assistant has no server of its own, so that reading belongs in genki or nowhere.

## Decision

- The file route serves a remote PDF itself when the document's record lists it and its origin is allowed. An operator allows origins with `GENAI_DOCUMENT_FILE_ORIGINS`, comma-separated `https://` origins written out in full, a trailing slash allowed (`remoteFileOriginsFrom` in `@genai/adapter-rest`). Anything else in the list is ignored, and with none the route behaves as in ADR 0065.
- The PDF is a file in the record's `files` with `mimetype` `application/pdf` (or a `.pdf` path without one), or the record's own `url` when that is a PDF, on `https` without credentials, on an allowed origin. Without `?file=` the route serves the first such file. With `?file=<address>` it serves that file only when it is one of them, both addresses compared as parsed URLs with the fragment cleared, so the case of the host and the encoding of the name do not matter; otherwise `404 document_file_not_found`. genki never reads an address the record does not list. A file whose record entry gives a `size` over the 50 MiB cap is none to show: the route answers `404 document_file_not_found`, to the JSON question too, and reads nothing, as Kunnskapsassistenten's own server does.
- The access is the route's: the caller must see the dataset as for `/api/datasets/{id}`, which for a hosted assistant's frontend means a dataset its service may search. Nothing remote is read before that check passes.
- The read follows no redirect, takes only `200` with `application/pdf`, stops past 50 MiB (by `content-length` or while streaming) and after 60 seconds, and ends the body when it does not start with `%PDF-`. A refusal before the body is `502 document_unavailable`.
- The answer is `application/pdf`, `inline`, `nosniff`, `private, no-store`, with `Content-Security-Policy: default-src 'none'; frame-ancestors 'self'`. With `Accept: application/json` the route says `{ kind: "served", mediaType, source }` without reading the source, so a host can decide before it frames it.
- The API's security headers keep a route's own policy only when it is one of the locked policies genki's routes write (`lockedPolicies` in `apps/api/src/hardening.ts`), and send `X-Frame-Options: SAMEORIGIN` only when that policy says `frame-ancestors 'self'`. Every other response keeps the platform policy and `DENY`. Without this the inline PDF of ADR 0065 could not be framed either.
- In the UI, `PdfView` in `@genai/ui-blocks` frames a PDF, or links to it on a small screen or where the browser has no viewer. Dokumentvisning uses it when the layout's `document-view` block has its option `file` («PDF-visning (beta)») on and the host gives `documentFile`. `createGenkiApi` offers `documentFile` through this route, and `apps/assistant` gives it only where it calls genki through the BFF, whose cookie the frame carries. It never hands the view a source's own address (`kind: "source"`): a site not on the list may forbid framing, so Dokumentvisning shows the excerpts and «Les dokumentet» instead, as for a document that is not a PDF.

## Why

- Kudos's own rule (no framing, no CORS) leaves a server-side read as the only way to show its PDFs, and a host per service is what ADR 0061 removes.
- An operator's list of origins, and only addresses the record itself lists, keeps the route from being a proxy: a caller can name no address of its own, and a record cannot send genki to a host the operator has not named.
- A `?file=` matched against the record, not taken as given, lets the view open the excerpt's own file at its page without trusting the page.
- Keeping a locked route policy in the header middleware, rather than a list of paths, keeps the rule where the policy is written, and a looser policy is still replaced.

Turned down: reading any `http(s)` address in the record (an SSRF path for whoever writes the source); storing a copy of every remote PDF at ingest (a change to ingest and the knowledge server, and storage for files nobody opens); framing the source directly (the source forbids it).

## Consequences

- An operator sets `GENAI_DOCUMENT_FILE_ORIGINS` for each source whose PDFs should show, in `appEnv` in each environment's parameter file (`infra/env/*.bicepparam`), never by hand on the container app. Test and prod list `https://kudos.dfo.no`; [infra/README.md](../../infra/README.md#settings-and-secrets) says how to add a site.
- The API now makes outbound requests to those origins on a reader's click. They are bounded by size and time, but they are not cached: a PDF opened twice is read twice.
- Tests: `packages/adapter-rest/src/rest.test.ts` ("a remote PDF genki serves"), `apps/api/src/hardening.test.ts`, `packages/ui-assembly/src/api.test.ts` ("a cited document’s file through genki"), `packages/ui-assembly/src/assistant.test.tsx` ("through genki’s file route").
