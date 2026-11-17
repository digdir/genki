# 0058 The state's organisation as a synced register

Status: proposed, 2026-11-16 (register built; org numbers on KUDOS documents, 2026-11-16; tool built, 2026-11-17)

Left: ownership of state companies and health trusts (issue 622), "tilknyttet", which no authority defines, and an answer to what changed in the organisation over time.

## Context

A service over agencies' documents is asked which agencies sit under a ministry, which ministry an agency is under, and what the agencies under a ministry wrote. The documents rarely say so. The answer must come from an authority, be current, and name its source and date.

- **Enhetsregisteret is the authority for "under".** Under rundskriv W-01/2019, each ministry registers which ministry its agencies (organisasjonsform ORGL) are under, as `overordnetEnhet` pointing to the ministry (STAT), and keeps that current. The data is open under NLOD 2.0.
- **DFØ's state accounts are a second authority.** Every state agency reports to the state accounts, which book it to its ministry (`Fagdepartement_Virksomhet`). The files are monthly, and yearly from 2014, under NLOD 2.0.
- **The two agree.** On 2026-11-16, 162 of the 177 agencies in the September 2026 accounts had the same ministry in both. Of the others, 11 were bodies under Stortinget, SMK, the courts or Sametinget that the accounts book under a ministry's budget, and four had no parent in the register.

## Decision

The platform keeps a copy of the state's organisation, read from the authorities every night. Services reach it through a platform-provided tool.

- **What is kept.** Each STAT unit and every ORGL unit that reaches one through its parents, at any depth: 324 units on 2026-11-16. Municipal units are left out. `packages/composition/src/state-register.ts` reads every STAT and ORGL unit from `data.brreg.no/enhetsregisteret/api/enheter`, `size=1000`, which is three calls.
- **Where it is kept.** It lives in the platform's versioned configuration entries, `platform` scope, under five kinds:
  - `state-register` (`enhetsregisteret`): the tree. A version is added only when the tree changed, with the changes since the version before: new, removed, a new parent or a new name. So the versions are the change history, and each change is dated the night the sync saw it. The register itself gives no date for when a parent link took effect.
  - `state-register-sync`: the last good sync and the failed nights in a row.
  - `state-accounts`: one entry per year (`year-YYYY`) and one for the latest month (`month`). Each holds every agency's ministry by org number.
  - `state-register-check`: the mismatches of the last month checked.
  - `state-register-names`: the display names and abbreviations KUDOS (run by DFØ) gives each unit of the register, joined by org number. KUDOS's old names are left out: it points "Difi" to DFØ alone, though Difi was split between DFØ and Digdir.
- **A bad read changes nothing.** A failed call, a page missing, fewer units than the register reported, or no STAT unit at all leaves the stored tree as it was. Only the sync status records the failure.
- **The register and the state accounts are read through the egress guard,** which allows only `data.brreg.no` and `statsregnskapet.dfo.no`. KUDOS's actors are read with KUDOS's own client and rate limiter, as ingestion reads KUDOS. The state accounts are zip files: the guard returns the raw bytes, and the CSV inside is inflated as a stream. That way a year's 130 MB never sits in memory at once.
- **The job.** The worker runs it at 02:40 Oslo time on one replica, under the leader lease `genai-worker-state-register`, and once at start when no register is stored. In order:
  1. It reads the register.
  2. It reads the latest month of the state accounts and keeps it when its period is new.
  3. It reads each year from 2014 to the latest month's year that is not yet stored with December, so a year read before DFØ closed it is read again until it holds December. In January the new year has no file yet, so it waits.
  4. It reads KUDOS's actors through KUDOS's own rate limiter.
  5. It compares the latest month with the register.
- **History.** A unit's ministry on a date before the first sync comes from that year's state accounts. A ministry renamed during a year keeps its old name on its own row there, so its code maps to the org number the latest month gives it. On a date after the first sync, it comes from the register version current on that date. A body the register places under Stortinget, SMK, the courts or Sametinget gets no answer from the accounts, which book it under a ministry for the budget only.
- **The monthly check.** Each agency in the latest month is compared with its top unit in the register:
  - **Same:** the accounts give the same ministry.
  - **Budget booking:** the register's top unit is not one of the accounts' ministries, as for Stortinget, SMK, the courts and Sametinget.
  - **Mismatch:** the accounts give another ministry than the register.
  - **Not in register:** the register has no state parent for the agency.

  The register stays the answer; the accounts never change it. The worker logs `state register mismatch` for a mismatch only the first month it appears.

- **Operators see it.**
  - **Console:** `GET /operator/state-register` (operators only) gives the dates, the unit count and every difference with both ministries named. The console shows it under Statens organisering, with the NLOD credit to Brønnøysundregistrene and DFØ and links to the licence and both sources.
  - **Alert:** after two failed nights in a row the worker logs `state register stale`, and the `state-register` log alert in `infra/modules/alerts.bicep` fires. Answers keep the date of the last good sync.
- **Services reach it through a platform-provided tool.** The tool is `state-organisation@1` (`packages/composition/src/state-organisation-tool.ts`). It is the platform's first built-in tool, registered with `ToolRegistry.register` and granted in a service's `spec.tools` like any other. The data is open, so any tenant's service may grant it. A service that does not grant it is not offered it, and the kernel refuses a port it has no grant for. It has three actions:
  - **under** lists the units directly under a unit, or 1 to 3 levels down with `depth`. Without a unit it lists the state's top units: the ministries, SMK, Stortinget, Domstolene and Sametinget.
  - **over** walks a unit up to its top unit, with every level between.
  - **find** turns a name into units. An exact match on the registered name, KUDOS's display name or its abbreviation wins, ignoring case, accents and punctuation. Otherwise it gives the units where every word asked for starts a word of a name, at most 20. KUDOS's old names never match.
- **Dates.** With `date`, under and over answer from the last register version read on or before that day in Oslo. A date that does not exist is refused. Before the first version, they answer from that year's state accounts: one level, the agencies booked to the ministry, labelled as the accounts.
- **What every answer carries.** The source (Enhetsregisteret, or Statsregnskapet for an answer from the accounts), the date: the last good sync, the version's date, or the accounts' year. It also carries a line to cite it by, and the NLOD credit naming the licensor, with links to the licence and the source. The tool's description asks the model to end its answer with the cite and credit lines. Unit names are untrusted data for the model.
- **Filter values.** When a dataset of the calling service declares `owner_orgnr` as a filter, the answer gives the units' org numbers as values for it, up to 100: the documents the units own. The agent's search never drops a filter on `owner_orgnr` or `recipient_orgnr` when it finds nothing. With other filters beside it, it first searches again with the org-number filter alone; when that finds nothing too, it tells the model that these organisations have no matching documents, so it cannot return other organisations' documents as theirs. A search with no org-number filter falls back to an unfiltered search as before. The retrieval's own auto-filter, when it finds nothing, keeps the filters the model set.

## Why

- **Answers must come only from authorities.** Enhetsregisteret is the register the ministries are required to keep current, and the state accounts are a second, independent authority that catches a slow or wrong registration. regjeringen.no was turned down: it is HTML only, laid out differently per ministry, and uses "tilknyttet" in two senses. Sikt's Forvaltningsdatabasen was turned down too: it is a research database whose data ended on 1 June 2026.
- **A synced copy rather than a live call.** A live call to Brønnøysund from each question was turned down for three reasons:
  - It adds outside calls while a user waits, two to four of them, since the tree must be walked.
  - It has no history, and no second authority to check against.
  - It would expose the whole API to the model, including `/roller`, which returns an agency head's name and birth date.
- **Configuration entries rather than tables.** The precedent is the USD/NOK rate (ADR 0040). Entries are append-only and versioned, so the change history needs no table of its own and no migration. A reorganisation is rare: the register patched `overordnetEnhet` five times across all ORGL from September 2025 to November 2026.
- **A full read rather than the change feed.** The full read is three calls a night and heals itself: a missed night is caught by the next. The change feed must never miss an event, and it carries the field that changed only since September 2025.
- **The ministry is not stamped on documents.** A document is filtered by its organisations' org numbers, and the ministry is looked up when the question is asked. That way a reorganisation needs no re-ingest, and an old document is not given today's ministry.

## Consequences

- New egress hosts for the worker: `data.brreg.no`, `statsregnskapet.dfo.no`, and `kudos.dfo.no`, which ingestion already uses.
- An answer about a reorganisation can be up to a day behind the register, and the register itself has lagged by weeks: Digdir's move to DFD on 1 January 2024 was registered on 23 January.
- History before the first sync has the year resolution of the state accounts, and none for the bodies of Stortinget, SMK, the courts and Sametinget.
- Built since (issue 620): KUDOS documents keep `owner_orgnr` and `recipient_orgnr`, and an operator fills them on stored documents with `knowledge.fields` (ADR 0042). A dataset declares both as filters to search by them.
- Built since (issue 621): the tool `state-organisation@1` and the kept org-number filter. A service uses it by granting it; its instructions should let the model treat the register as a source.
- The tool cannot tell what changed in the organisation over time; that needs its own action.
