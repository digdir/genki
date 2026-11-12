# Throughput: docling-tess, documents split across N containers

List price $1.552/h. Round = containers started to all exited (load and warm-up included). Cost and projections are list price x round time: **projections**, not measurements.

| Workers | Threads each | Docs | Pages | Failed docs | Round s | Pages/h (round) | Pages/h (converting) | CPU busy | $ / 1,000 pages | Phase 1 $ / VM-h | All KUDOS $ / VM-h | Workers finished (s after start) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| 4 | 8 | 39 | 1100 | 0 | 972 | 4,073 | 4,129 | 61% | 0.381 | 246 / 159 | 1,197 / 771 | 581, 573, 971, 810 |
| 8 | 4 | 39 | 1100 | 0 | 732 | 5,413 | 5,547 | 76% | 0.287 | 185 / 119 | 901 / 580 | 492, 334, 702, 722, 730, 592, 575, 475 |
