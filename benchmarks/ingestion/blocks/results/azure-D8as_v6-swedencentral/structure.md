# Block structure: docling, docling-no, docling-rapid, docling-tess, marker

Run folders: /home/azureuser/blocks/.data/runs/azure-D8as_v6-swedencentral. Counts from `blocks.jsonl`; see `normalise.py` for the block format and `compare.py` for each column.

## Per parser, all documents

| Parser        | Documents | Blocks | Characters | Headings | Heading levels | List items | Tables | Furniture | Empty | æøå per 1,000 letters |
| ------------- | --------: | -----: | ---------: | -------: | -------------- | ---------: | -----: | --------: | ----: | --------------------: |
| docling       |        15 |   4281 |     789563 |      661 | [1]            |        463 |     92 |       976 |    10 |         16.1 (median) |
| docling-no    |        15 |   4283 |     790669 |      659 | [1]            |        462 |     92 |       977 |    10 |         19.8 (median) |
| docling-rapid |        15 |   4311 |     796120 |      661 | [1]            |        477 |     92 |       987 |    10 |         19.7 (median) |
| docling-tess  |        15 |   4315 |     801838 |      662 | [1]            |        477 |     92 |       971 |    10 |         20.0 (median) |
| marker        |         5 |    429 |      65763 |       94 | [1, 2, 3, 4]   |         69 |      7 |        50 |     0 |         20.7 (median) |

## Seconds per page

| Parser        | azure-D8as_v6-swedencentral |
| ------------- | --------------------------: |
| docling       |            4.75 (332 pages) |
| docling-no    |            4.80 (332 pages) |
| docling-rapid |            2.02 (332 pages) |
| docling-tess  |            1.61 (332 pages) |
| marker        |            62.59 (31 pages) |

## Per document

| Document | Pages                 | Parser        |            Blocks | Characters | Headings | Levels    | List items | Tables | Furniture | æøå/1,000 |  s/page |
| -------- | --------------------- | ------------- | ----------------: | ---------: | -------: | --------- | ---------: | -----: | --------: | --------: | ------: |
| 33245    | digital               | docling       |                33 |       2088 |        4 | [1]       |          2 |      3 |         4 |      13.1 |   4.305 |
| 33245    | digital               | docling-no    |                33 |       2088 |        4 | [1]       |          2 |      3 |         4 |      13.1 |   4.271 |
| 33245    | digital               | docling-rapid |                33 |       2093 |        4 | [1]       |          2 |      3 |         4 |      13.1 |   2.119 |
| 33245    | digital               | docling-tess  |                34 |       2097 |        4 | [1]       |          2 |      3 |         4 |      13.1 |   2.082 |
| 33245    | digital               | marker        |                28 |       1915 |        6 | [1, 2, 4] |          0 |      2 |         7 |      14.2 |  21.329 |
| 339679   | digital               | docling       |                61 |      12288 |       16 | [1]       |          1 |      2 |         5 |      19.7 |   1.178 |
| 339679   | digital               | docling-no    |                61 |      12288 |       16 | [1]       |          1 |      2 |         5 |      19.8 |   1.182 |
| 339679   | digital               | docling-rapid |                61 |      12289 |       16 | [1]       |          1 |      2 |         5 |      19.7 |   1.147 |
| 339679   | digital               | docling-tess  |                62 |      12298 |       16 | [1]       |          1 |      2 |         5 |      19.8 |   1.072 |
| 339679   | digital               | marker        |                60 |      12299 |       16 | [1, 3, 4] |          0 |      4 |         5 |      19.2 |  20.987 |
| 8562     | image-only            | docling       |                61 |       6935 |       11 | [1]       |         25 |      0 |         2 |       0.0 |  11.822 |
| 8562     | image-only            | docling-no    |                61 |       7029 |       11 | [1]       |         25 |      0 |         2 |      21.2 |  11.871 |
| 8562     | image-only            | docling-rapid |                63 |       7060 |       11 | [1]       |         25 |      0 |         4 |      21.5 |   3.001 |
| 8562     | image-only            | docling-tess  |                60 |       7076 |       12 | [1]       |         25 |      0 |         0 |      21.4 |   2.525 |
| 8562     | image-only            | marker        |                61 |       7119 |       11 | [1, 2, 4] |         23 |      0 |         4 |      21.5 | 347.209 |
| 5944     | scan+text             | docling       |                60 |       7741 |       14 | [1]       |         14 |      0 |         4 |       0.0 |   9.802 |
| 5944     | scan+text             | docling-no    |                60 |       7690 |       14 | [1]       |         14 |      0 |         4 |      21.8 |   9.825 |
| 5944     | scan+text             | docling-rapid |                60 |       7783 |       14 | [1]       |         14 |      0 |         4 |      21.8 |    4.13 |
| 5944     | scan+text             | docling-tess  |                61 |       7862 |       15 | [1]       |         14 |      0 |         4 |      22.2 |   3.227 |
| 5944     | scan+text             | marker        |                61 |       7920 |       14 | [1, 2, 4] |         14 |      0 |         4 |      22.2 |   20.28 |
| 330305   | digital, scan+text    | docling       |               246 |      44712 |       43 | [1]       |         65 |      0 |        28 |      19.4 |   2.625 |
| 330305   | digital, scan+text    | docling-no    |               246 |      44702 |       43 | [1]       |         65 |      0 |        28 |      20.4 |   2.664 |
| 330305   | digital, scan+text    | docling-rapid |               246 |      44405 |       43 | [1]       |         65 |      0 |        28 |      20.5 |   1.309 |
| 330305   | digital, scan+text    | docling-tess  |               246 |      44762 |       43 | [1]       |         65 |      0 |        28 |      20.4 |   1.059 |
| 330305   | digital, scan+text    | marker        |               219 |      36510 |       47 | [1, 2, 4] |         32 |      1 |        30 |      20.7 |  20.159 |
| 372605   | digital, scan+text    | docling       |               123 |      25334 |       20 | [1]       |         11 |      1 |        27 |      30.9 |   4.054 |
| 372605   | digital, scan+text    | docling-no    |               123 |      25276 |       20 | [1]       |         11 |      1 |        27 |      31.0 |   4.107 |
| 372605   | digital, scan+text    | docling-rapid |               123 |      25369 |       20 | [1]       |         11 |      1 |        27 |      31.1 |   2.137 |
| 372605   | digital, scan+text    | docling-tess  |               123 |      25201 |       20 | [1]       |         11 |      1 |        27 |      31.4 |   1.221 |
| 372605   | digital, scan+text    | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 51059    | digital               | docling       |               203 |      46751 |       30 | [1]       |          0 |      2 |        42 |       0.2 |   4.597 |
| 51059    | digital               | docling-no    |               203 |      46715 |       30 | [1]       |          0 |      2 |        42 |       0.2 |   4.671 |
| 51059    | digital               | docling-rapid |               212 |      48405 |       30 | [1]       |          0 |      2 |        42 |       0.1 |   3.081 |
| 51059    | digital               | docling-tess  |               204 |      47855 |       30 | [1]       |          0 |      2 |        41 |       1.4 |   2.135 |
| 51059    | digital               | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 5418     | image-only, scan+text | docling       |               172 |      49436 |       24 | [1]       |         38 |      0 |        18 |       0.0 |   4.405 |
| 5418     | image-only, scan+text | docling-no    |               170 |      49425 |       24 | [1]       |         38 |      0 |        18 |       0.0 |   4.431 |
| 5418     | image-only, scan+text | docling-rapid |               172 |      49439 |       24 | [1]       |         38 |      0 |        18 |       0.0 |   1.167 |
| 5418     | image-only, scan+text | docling-tess  |               185 |      49494 |       24 | [1]       |         38 |      0 |        18 |       0.1 |   0.899 |
| 5418     | image-only, scan+text | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 355302   | digital               | docling       |               432 |      57877 |       43 | [1]       |        104 |      8 |        81 |      11.2 |     6.7 |
| 355302   | digital               | docling-no    |               434 |      59254 |       43 | [1]       |        103 |      8 |        81 |      19.4 |   6.731 |
| 355302   | digital               | docling-rapid |               425 |      58684 |       43 | [1]       |        118 |      8 |        81 |      19.3 |    3.05 |
| 355302   | digital               | docling-tess  |               441 |      60628 |       43 | [1]       |        118 |      8 |        86 |      20.1 |    2.29 |
| 355302   | digital               | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 46870    | digital, image-only   | docling       |               175 |      44225 |       27 | [1]       |         20 |      4 |        17 |      17.1 |    5.96 |
| 46870    | digital, image-only   | docling-no    |               177 |      44247 |       27 | [1]       |         20 |      4 |        17 |      17.1 |   5.995 |
| 46870    | digital, image-only   | docling-rapid |               181 |      44346 |       27 | [1]       |         20 |      4 |        17 |      17.0 |   1.192 |
| 46870    | digital, image-only   | docling-tess  |               177 |      44210 |       27 | [1]       |         20 |      4 |        17 |      17.1 |   1.121 |
| 46870    | digital, image-only   | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 19582    | digital               | docling       |               365 |      88965 |       34 | [1]       |         35 |      0 |        89 |      20.0 |   0.742 |
| 19582    | digital               | docling-no    |               365 |      88965 |       34 | [1]       |         35 |      0 |        89 |      20.0 |   0.822 |
| 19582    | digital               | docling-rapid |               365 |      88974 |       34 | [1]       |         35 |      0 |        89 |      20.0 |   0.709 |
| 19582    | digital               | docling-tess  |               367 |      88977 |       34 | [1]       |         35 |      0 |        89 |      20.0 |   0.679 |
| 19582    | digital               | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 75814    | image-only            | docling       |               249 |      48465 |       54 | [1]       |          0 |     18 |        32 |       0.0 |    10.4 |
| 75814    | image-only            | docling-no    |               249 |      48181 |       52 | [1]       |          0 |     18 |        33 |      27.7 |  10.422 |
| 75814    | image-only            | docling-rapid |               258 |      52054 |       54 | [1]       |          0 |     18 |        34 |      26.0 |    4.51 |
| 75814    | image-only            | docling-tess  |               248 |      56570 |       53 | [1]       |          0 |     18 |        25 |      25.9 |   3.332 |
| 75814    | image-only            | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 31196    | digital, scan+text    | docling       |               472 |      84839 |       85 | [1]       |         45 |      3 |       136 |      16.1 |   1.124 |
| 31196    | digital, scan+text    | docling-no    |               472 |      84839 |       85 | [1]       |         45 |      3 |       136 |      16.1 |   1.163 |
| 31196    | digital, scan+text    | docling-rapid |               470 |      84835 |       85 | [1]       |         45 |      3 |       136 |      16.1 |   0.848 |
| 31196    | digital, scan+text    | docling-tess  |               470 |      84831 |       85 | [1]       |         45 |      3 |       136 |      16.1 |   0.769 |
| 31196    | digital, scan+text    | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 19557    | digital               | docling       |               493 |     130185 |      100 | [1]       |         11 |      0 |        97 |      22.3 |   0.975 |
| 19557    | digital               | docling-no    |               493 |     130183 |      100 | [1]       |         11 |      0 |        97 |      22.3 |    1.01 |
| 19557    | digital               | docling-rapid |               493 |     130185 |      100 | [1]       |         11 |      0 |        97 |      22.3 |   0.794 |
| 19557    | digital               | docling-tess  |               497 |     130217 |      100 | [1]       |         11 |      0 |        97 |      22.3 |    0.77 |
| 19557    | digital               | marker        | failed or missing |            |          |           |            |        |           |           |         |
| 102474   | digital, image-only   | docling       |              1136 |     139722 |      156 | [1]       |         92 |     51 |       394 |      18.9 |   8.534 |
| 102474   | digital, image-only   | docling-no    |              1136 |     139787 |      156 | [1]       |         92 |     51 |       394 |      19.0 |   8.653 |
| 102474   | digital, image-only   | docling-rapid |              1149 |     140199 |      156 | [1]       |         92 |     51 |       401 |      18.9 |    3.05 |
| 102474   | digital, image-only   | docling-tess  |              1140 |     139760 |      156 | [1]       |         92 |     51 |       394 |      19.0 |    2.64 |
| 102474   | digital, image-only   | marker        | failed or missing |            |          |           |            |        |           |           |         |
