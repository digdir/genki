# Search engines for Kudos: Typesense and pgvector

76 draft questions on 61 documents, three rounds each, through Kunnskapsassistenten's retrieve-only service on a local Typesense holding only the pilot's documents and on pgvector, both reranked with ColBERT. Typesense is the current side, pgvector the candidate; the primary metric is document Recall@10 as served, and the margin is 2 points.

## Answer

By Recall@10 as served, tier 1: pgvector, Typesense, phrase step off; tier 2: Typesense. pgvector minus Typesense is +11.2 points (95% interval +3.0 to +19.9): better at a 2-point margin, and this sample detects differences of 12.1 points or more.

## Tiers (quality only)

| Tier | Side | Recall@10 as served | Recall@10 credited | MRR as served | nDCG@10 as served |
| --- | --- | ---: | ---: | ---: | ---: |
| 1 | pgvector | 95.8 | 95.8 | 86.5 | 88.7 |
| 1 | Typesense, phrase step off | 88.4 | 89.7 | 84.7 | 85.1 |
| 2 | Typesense | 84.6 | 85.5 | 80.9 | 81.6 |

A side starts a new tier only when it is significantly worse than the top of its tier, after correcting for every pair compared.

## Paired differences

✱ marks an interval that leaves out zero; the verdict is against a 2-point margin; *borderline* means the verdict or the mark changed when rerun with two other seeds.

### As served

| Pair | Metric | Difference | Detectable (points) |
| --- | --- | --- | --- |
| pgvector − Typesense | Recall@10 | +11.2 ✱ (+3.0 to +19.9), better | 12.1 |
| pgvector − Typesense | Recall@5 | +11.8 ✱ (+3.2 to +21.1), better | 12.7 |
| pgvector − Typesense | MRR | +5.6 (−3.1 to +14.6), inconclusive | 12.8 |
| pgvector − Typesense | nDCG@10 | +7.1 (−1.1 to +15.8), not worse | 12.2 |
| Typesense, phrase step off − Typesense | Recall@10 | +3.7 (−0.4 to +8.2), not worse | 6.1 |
| Typesense, phrase step off − Typesense | Recall@5 | +3.7 (−0.8 to +8.7), not worse | 6.8 |
| Typesense, phrase step off − Typesense | MRR | +3.8 (−0.7 to +8.8), not worse | 6.8 |
| Typesense, phrase step off − Typesense | nDCG@10 | +3.5 (−0.9 to +8.4), not worse | 6.6 |
| pgvector − Typesense, phrase step off | Recall@10 | +7.5 (−0.7 to +16.5), not worse | 12.4 |
| pgvector − Typesense, phrase step off | Recall@5 | +8.1 (−0.2 to +17.3), not worse | 12.5 |
| pgvector − Typesense, phrase step off | MRR | +1.8 (−7.2 to +11.3), inconclusive | 13.2 |
| pgvector − Typesense, phrase step off | nDCG@10 | +3.6 (−4.9 to +12.8), inconclusive | 12.6 |

### Typesense credited with every holder of a chunk

| Pair | Metric | Difference | Detectable (points) |
| --- | --- | --- | --- |
| pgvector − Typesense | Recall@10 | +10.3 ✱ (+1.9 to +19.4), better | 12.5 |
| pgvector − Typesense | Recall@5 | +11.0 ✱ (+2.3 to +20.2), better | 12.8 |
| pgvector − Typesense | MRR | +5.2 (−3.9 to +14.5), inconclusive | 13.2 |
| pgvector − Typesense | nDCG@10 | +6.7 (−1.7 to +15.7), not worse | 12.4 |
| Typesense, phrase step off − Typesense | Recall@10 | +4.2 ✱ (0.0 to +8.8), better, *borderline* | 6.2 |
| Typesense, phrase step off − Typesense | Recall@5 | +4.2 (−0.4 to +9.2), not worse | 6.9 |
| Typesense, phrase step off − Typesense | MRR | +4.0 (−0.8 to +8.8), not worse | 6.8 |
| Typesense, phrase step off − Typesense | nDCG@10 | +3.8 (−0.7 to +8.6), not worse | 6.6 |
| pgvector − Typesense, phrase step off | Recall@10 | +6.1 (−2.6 to +15.6), inconclusive | 13.1 |
| pgvector − Typesense, phrase step off | Recall@5 | +6.8 (−2.0 to +16.3), not worse, *borderline* | 13.1 |
| pgvector − Typesense, phrase step off | MRR | +1.3 (−8.2 to +10.9), inconclusive | 13.8 |
| pgvector − Typesense, phrase step off | nDCG@10 | +3.0 (−5.8 to +12.2), inconclusive | 13.0 |

## Where they disagree

Questions whose right document is in the top ten in every round on one engine and in none on the other: pgvector only 5, Typesense only 1.

### Only pgvector finds the document (5)

- `ka-kudos-006-factual`: "Hva har vært prioritert i barneverns- og helsenemndene i 2024 og 2025 ifølge Prop. 1 S (2025–2026)?" (Prop. 1 S (2025–2026))
- `ka-kudos-018-factual`: "Hva investerer tjenesteytende bedrifter i ifølge Norges Banks Regionalt nettverk i 2025?" (Regionalt nettverk - Nasjonal rapport)
- `ka-kudos-049-factual`: "Hvor stor var realnedgangen i bevilgningen fra Kunnskapsdepartementet til NHH i 2024?" (Årsrapport Norges Handelshøyskole 2023)
- `ka-kudos-050-factual`: "Hvilke tre satsingsområder prioriteres i NHHs strategi for 2022–2025?" (Årsrapport Norges Handelshøyskole 2023)
- `ka-kudos-062-factual`: "Hvor stort område ble krypsiv fjernet fra i Rysstadbassenget i juni 2020, og hvordan ble det gjort?" (Gjenvekst av krypsiv etter tiltak, og effekter av kalking på krypsiv i Otra ved Rysstad : Oppdatert status 2023)

### Only Typesense finds the document (1)

- `ka-kudos-074-factual`: "Hva viser kolonnen «samlet tildeling» i bevilgningsrapporteringen til Norges institusjon for menneskerettigheter?" (Årsrapport Norges institusjon for menneskerettigheter 2023)

## How the reference was made

The reference is `reference/questions.jsonl`: the questions of Kunnskapsassistenten's draft test set (`packages/eval/testsets/ka-kudos-draft.yaml`) that name the documents that answer them, by their old Typesense ids, which `../sample.json` maps to KUDOS documents. Two reports KUDOS now holds under new registrations are matched by title and date, and a hit on either counts. Intervals resample whole documents.

## Instrument checks

- **No real difference (A/A).** pgvector's and Typesense's results swapped at random within each document, 1000 times: the 95% interval left out zero 7.2% of the time. About 5% is right; a little more means the intervals run slightly narrow with this few documents, so read an interval that ends near zero with care.
- **A known loss.** pgvector with every question missed on a seeded share of documents, against intact: 5% of documents −2.6 (−6.8 to 0.0), inconclusive; 10% of documents −7.0 ✱ (−14.5 to −1.3), inconclusive.

## Limits

- 76 questions on 61 documents: the interval only rules out large differences, and the questions are near the ceiling for both engines.
- The questions were written from Typesense passages, which may favour Typesense, and no person has reviewed them.
- The local Typesense holds only the pilot's documents, copied read-only from the shared test cluster with its schema; its phrase vectors were recomputed with the same model.
- Three rounds per question even out some of gpt-4o's planning variance, not all of it.
- Both engines search 299 documents; all of Kudos is about 40,000.
- The margin was set on 26 October 2026, after the runs, when the benchmark moved to this layout.

## Words used here

- **Reference**: the known-right answers every side is measured against, made without looking at any side's output.
- **Side**: one of the things compared: the current component, or a candidate for replacing it.
- **Paired difference**: both sides graded on exactly the same items, so the difference compares like with like.
- **95% interval**: the range the difference would likely fall in with another sample of documents, from resampling whole documents. If it leaves out zero, the difference is unlikely to be chance (✱).
- **Margin**: how much worse a candidate may be and still replace the current side, set before the run.
- **Verdict**: better: the whole interval is above zero. Not worse: the whole interval is above minus the margin. Worse: the whole interval is below minus the margin. Inconclusive: none of these; more items are needed.
- **Detectable**: the smallest difference this sample would find with 80% power. A difference smaller than this can hide in a sample this size.
- **Tier**: sides that the data can't tell apart, after correcting for comparing several pairs at once.
- **Typesense**: the search engine Kudos uses today: chunks of each document, plus short search phrases with their own vectors that the planner looks up first.
- **pgvector**: Postgres with vector search: here one passage per page, keyword and vector search fused (RRF).
- **Planner**: gpt-4o rewriting the question into several searches before searching. With the phrase step, it first looks up stored phrases and rewords them (two model calls); blind, it writes its searches in one call.
- **ColBERT**: a second, more careful model that re-orders what the search found. Both sides use it.
- **As served / credited**: Typesense's chunk ids are not unique across documents, so it can return a passage under another document than the one it found. As served counts the document it returned; credited also counts every pilot document that holds that chunk (its best case).
- **Recall@10**: the share of questions whose right document is among the first ten passages.
- **MRR**: how high the right document sits: first place counts 1, second 1/2, not found 0, averaged.

## Notes: time and cost (not part of the ranking)

- Typesense: 228 searches, p50 6.5 s, p95 10.3 s per search, planner included.
- pgvector: 228 searches, p50 3.7 s, p95 6.3 s per search, planner included.
- Typesense, phrase step off: 228 searches, p50 3.6 s, p95 7.3 s per search, planner included.
- Typesense's phrase step makes a second gpt-4o call before searching; blind planning makes one.

## Run record

| Side | Commit | Uncommitted changes | Published | Reference | Run |
| --- | --- | --- | --- | --- | --- |
| Typesense | 6d7339a0d7da | yes | 2026-10-26T14:41:33+00:00 | 67f647486eee | typesense-vs-pgvector.json |
| pgvector | 6d7339a0d7da | yes | 2026-10-26T14:41:33+00:00 | 67f647486eee | typesense-vs-pgvector.json |
| Typesense, phrase step off | 6d7339a0d7da | yes | 2026-10-26T14:41:33+00:00 | 67f647486eee | typesense-phrase-step-off.json |
