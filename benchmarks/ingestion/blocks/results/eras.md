# Page kinds across the KUDOS archive

50 documents drawn at random per era from the KUDOS listing (seed 20261111), every page classified as in `../checks.py`. Shares are of pages, weighted to each era's pages in the listing (within an era every drawn document counts by its pages). `eras_sample.py` made this file.

| Era         | Documents in KUDOS | Pages in KUDOS |       Classified | Digital | Scan + text | Image-only | Blank | Pages with tables | Two-column pages | Hard / medium / easy documents |
| ----------- | -----------------: | -------------: | ---------------: | ------: | ----------: | ---------: | ----: | ----------------: | ---------------: | ------------------------------ |
| before 2000 |              1,039 |        112,449 | 50 docs, 4,965 p |   55.5% |       30.4% |       7.6% |  6.4% |             30.1% |             6.8% | 33 / 3 / 14                    |
| 2000-2009   |              7,649 |        550,437 | 50 docs, 3,511 p |   95.6% |        0.9% |       0.6% |  2.9% |             20.3% |            24.9% | 34 / 9 / 7                     |
| 2010-2019   |             17,760 |      1,184,803 | 50 docs, 3,590 p |   94.5% |        3.0% |       0.3% |  2.2% |             19.3% |            11.9% | 33 / 10 / 7                    |
| 2020 on     |             19,449 |      1,112,322 | 50 docs, 2,842 p |   94.7% |        0.6% |       1.9% |  2.9% |             25.6% |             7.3% | 30 / 11 / 9                    |

Whole archive, weighted by era: digital 93.3%, scan+text 2.8%, image-only 1.2%, blank 2.7%.

Hard: any image-only page, 10% or more scanned pages, tables on 20% or more of pages, or two columns on 30% or more. Easy: no scanned pages, tables on under 5% and two columns on under 10% of pages. Tables are found by PyMuPDF on digital pages only, so tables on scans are not counted.

Failed or skipped downloads: {}.
