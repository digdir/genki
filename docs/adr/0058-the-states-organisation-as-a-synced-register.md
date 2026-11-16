# 0058 The state's organisation as a synced register

Status: proposed, 2026-11-16

Left: ownership of state companies and health trusts (issue 622), and "tilknyttet", which no authority defines.

## Context

A service over agencies' documents is asked which agencies sit under a ministry, which ministry an agency is under, and what the agencies under a ministry wrote. The documents rarely say so. The answer must come from an authority, be current, and name its source and date.

- **Enhetsregisteret is the authority for "under".** Under rundskriv W-01/2019, each ministry registers which ministry its agencies (organisasjonsform ORGL) are under, as `overordnetEnhet` pointing to the ministry (STAT), and keeps that current. The data is open under NLOD 2.0.
- **DFØ's state accounts are a second authority.** Every state agency reports to the state accounts, which book it to its ministry (`Fagdepartement_Virksomhet`). The files are monthly, and yearly from 2014, under NLOD 2.0.
- **The two agree.** On 2026-11-16, 162 of the 178 agencies in the September 2026 accounts had the same ministry in both. The others were bodies under Stortinget, SMK, the courts or Sametinget that the accounts book under a ministry's budget, and five with no parent in the register.

## Decision

The platform keeps a copy of the state's organisation, read from the authorities every night. Services reach it through a platform-provided tool.

- **What is kept.** Each STAT unit and every ORGL unit that reaches one through its parents, at any depth: 324 units on 2026-11-16. Municipal units are left out. `packages/composition/src/state-register.ts` reads every STAT and ORGL unit from `data.brreg.no/enhetsregisteret/api/enheter`, `size=1000`, which is three calls.
- **Where it is kept.** It lives in the platform's versioned configuration entries, `platform` scope, under five kinds:
  - `state-register` (`enhetsregisteret`): the tree. A version is added only when the tree changed, with the changes since the version before: new, removed, or a new parent. So the versions are the change history, and each change is dated the night the sync saw it. The register itself gives no date for when a parent link took effect.
  - `state-register-sync`: the last good sync and the failed nights in a row.
  - `state-accounts`: one entry per year (`year-YYYY`) and one for the latest month (`month`). Each holds every agency's ministry by org number.
  - `state-register-check`: the mismatches of the last month checked.
  - `state-register-names`: the display names and abbreviations KUDOS (run by DFØ) gives each unit of the register, joined by org number. KUDOS's old names are left out: it points "Difi" to DFØ alone, though Difi was split between DFØ and Digdir.
- **A bad read changes nothing.** A failed call, a page missing, fewer units than the register reported, or no STAT unit at all leaves the stored tree as it was. Only the sync status records the failure.
- **Reads go through the egress guard.** The only hosts allowed are `data.brreg.no` and `statsregnskapet.dfo.no`. The state accounts are zip files: the guard returns the raw bytes, and the CSV inside is inflated as a stream. That way a year's 130 MB never sits in memory at once.
- **The job.** The worker runs it at 02:40 Oslo time on one replica, under the leader lease `genai-worker-state-register`, and once at start when no register is stored. In order:
  1. It reads the register.
  2. It loads each closed year of the state accounts that is missing, from 2014.
  3. It reads the latest month and keeps it when its period is new.
  4. It reads KUDOS's actors through KUDOS's own rate limiter.
  5. It compares the latest month with the register.
- **History.** A unit's ministry on a date before the first sync comes from that year's state accounts. On a date after the first sync, it comes from the register version current on that date.
- **The monthly check.** Each agency in the latest month is compared with its top unit in the register:
  - **Same:** the accounts give the same ministry.
  - **Budget booking:** the register's top unit is not one of the accounts' ministries, as for Stortinget, SMK, the courts and Sametinget.
  - **Mismatch:** the accounts give another ministry than the register.
  - **Not in register:** the register has no state parent for the agency.

  The register stays the answer; the accounts never change it. The worker logs `state register mismatch` for a mismatch only the first month it appears.

- **Operators see it.**
  - **Console:** `GET /operator/state-register` (operators only) gives the dates, the unit count and every difference with both ministries named. The console shows it under Statens organisering.
  - **Alert:** after two failed nights in a row the worker logs `state register stale`, and the `state-register` log alert in `infra/modules/alerts.bicep` fires. Answers keep the date of the last good sync.
- **Services reach it through a platform-provided tool.** The tool is `state-organisation@1`, built in issue 621. It is the platform's first built-in tool, registered with `ToolRegistry.register` and granted in a service's `spec.tools` like any other. It answers "under", "over" and "find", and gives every result its source and date. The data is open, so any tenant's service may grant it. Unit names in its answers are untrusted data for the model.

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
- History before the first sync has the year resolution of the state accounts. The accounts book Stortinget's bodies under FIN, which the history shows as it is.
- Not built yet:
  - The tool and its use by a service (issue 621).
  - Owner and recipient org numbers on KUDOS documents, so a search can filter by them (issue 620).
