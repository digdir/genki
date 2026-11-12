# Block structure: docling-tess, docling-tess-best, docling-tess-egret, docling-tess-nocells, docling-tess-noreng, docling-tess-repair

Run folders: /home/azureuser/blocks/.data/runs/azure-D32as_v6-swedencentral-run2. Counts from `blocks.jsonl`; see `normalise.py` for the block format and `compare.py` for each column.

## Per parser, all documents

| Parser               | Documents | Blocks | Characters | Headings | Heading levels | List items | Tables | Furniture | Empty | æøå per 1,000 letters |
| -------------------- | --------: | -----: | ---------: | -------: | -------------- | ---------: | -----: | --------: | ----: | --------------------: |
| docling-tess         |        39 |  14174 |    2596279 |     1965 | [1]            |       1228 |    371 |      2211 |    13 |         19.5 (median) |
| docling-tess-best    |        39 |  14235 |    2596281 |     1965 | [1]            |       1225 |    371 |      2211 |    13 |         19.5 (median) |
| docling-tess-egret   |        39 |  14019 |    2598621 |     1990 | [1]            |       1415 |    380 |      1882 |    12 |         19.5 (median) |
| docling-tess-nocells |        39 |  14175 |    2568139 |     1965 | [1]            |       1228 |    371 |      2211 |    13 |         19.5 (median) |
| docling-tess-noreng  |        39 |  14201 |    2596644 |     1965 | [1]            |       1224 |    371 |      2211 |    13 |         19.5 (median) |
| docling-tess-repair  |        39 |  14174 |    2596279 |     1965 | [1]            |       1228 |    371 |      2211 |    13 |         19.5 (median) |

## Seconds per page

| Parser               | azure-D32as_v6-swedencentral-run2 |
| -------------------- | --------------------------------: |
| docling-tess         |                 1.85 (1100 pages) |
| docling-tess-best    |                 2.10 (1100 pages) |
| docling-tess-egret   |                 1.82 (1100 pages) |
| docling-tess-nocells |                 1.81 (1100 pages) |
| docling-tess-noreng  |                 1.95 (1100 pages) |
| docling-tess-repair  |                 1.81 (1100 pages) |

## Per document

| Document | Pages                                 | Parser               | Blocks | Characters | Headings | Levels | List items | Tables | Furniture | æøå/1,000 | s/page |
| -------- | ------------------------------------- | -------------------- | -----: | ---------: | -------: | ------ | ---------: | -----: | --------: | --------: | -----: |
| 33245    | digital                               | docling-tess         |     34 |       2097 |        4 | [1]    |          2 |      3 |         4 |      13.1 |  1.715 |
| 33245    | digital                               | docling-tess-best    |     35 |       2101 |        4 | [1]    |          2 |      3 |         4 |      13.1 |  1.919 |
| 33245    | digital                               | docling-tess-egret   |     28 |       1997 |        4 | [1]    |          2 |      3 |         7 |      13.7 |  1.894 |
| 33245    | digital                               | docling-tess-nocells |     34 |       2054 |        4 | [1]    |          2 |      3 |         4 |      13.4 |  1.763 |
| 33245    | digital                               | docling-tess-noreng  |     35 |       2101 |        4 | [1]    |          2 |      3 |         4 |      13.1 |   1.92 |
| 33245    | digital                               | docling-tess-repair  |     34 |       2097 |        4 | [1]    |          2 |      3 |         4 |      13.1 |  1.756 |
| 339679   | digital                               | docling-tess         |     62 |      12298 |       16 | [1]    |          1 |      2 |         5 |      19.8 |  0.657 |
| 339679   | digital                               | docling-tess-best    |     63 |      12299 |       16 | [1]    |          1 |      2 |         5 |      19.8 |  0.715 |
| 339679   | digital                               | docling-tess-egret   |     62 |      12299 |       16 | [1]    |          0 |      2 |         5 |      19.8 |  0.629 |
| 339679   | digital                               | docling-tess-nocells |     62 |      12311 |       16 | [1]    |          1 |      2 |         5 |      19.8 |    0.7 |
| 339679   | digital                               | docling-tess-noreng  |     62 |      12298 |       16 | [1]    |          1 |      2 |         5 |      19.8 |    0.7 |
| 339679   | digital                               | docling-tess-repair  |     62 |      12298 |       16 | [1]    |          1 |      2 |         5 |      19.8 |  0.695 |
| 8562     | image-only                            | docling-tess         |     60 |       7076 |       12 | [1]    |         25 |      0 |         0 |      21.4 |  2.365 |
| 8562     | image-only                            | docling-tess-best    |     60 |       7057 |       12 | [1]    |         25 |      0 |         0 |      21.4 |  3.117 |
| 8562     | image-only                            | docling-tess-egret   |     57 |       7068 |       11 | [1]    |         24 |      0 |         0 |      21.4 |  2.317 |
| 8562     | image-only                            | docling-tess-nocells |     60 |       7076 |       12 | [1]    |         25 |      0 |         0 |      21.4 |  2.333 |
| 8562     | image-only                            | docling-tess-noreng  |     60 |       7076 |       12 | [1]    |         25 |      0 |         0 |      21.2 |  2.615 |
| 8562     | image-only                            | docling-tess-repair  |     60 |       7076 |       12 | [1]    |         25 |      0 |         0 |      21.4 |  2.316 |
| 5944     | scan+text                             | docling-tess         |     61 |       7862 |       15 | [1]    |         14 |      0 |         4 |      22.2 |  3.074 |
| 5944     | scan+text                             | docling-tess-best    |     61 |       7864 |       15 | [1]    |         14 |      0 |         4 |      22.2 |  3.739 |
| 5944     | scan+text                             | docling-tess-egret   |     60 |       7858 |       14 | [1]    |         14 |      0 |         4 |      22.2 |  2.985 |
| 5944     | scan+text                             | docling-tess-nocells |     61 |       7862 |       15 | [1]    |         14 |      0 |         4 |      22.2 |  3.047 |
| 5944     | scan+text                             | docling-tess-noreng  |     61 |       7862 |       15 | [1]    |         14 |      0 |         4 |      22.2 |  3.371 |
| 5944     | scan+text                             | docling-tess-repair  |     61 |       7862 |       15 | [1]    |         14 |      0 |         4 |      22.2 |  3.005 |
| 330305   | digital, scan+text                    | docling-tess         |    246 |      44762 |       43 | [1]    |         65 |      0 |        28 |      20.4 |  0.667 |
| 330305   | digital, scan+text                    | docling-tess-best    |    246 |      44759 |       43 | [1]    |         65 |      0 |        28 |      20.4 |  0.716 |
| 330305   | digital, scan+text                    | docling-tess-egret   |    246 |      44981 |       46 | [1]    |         63 |      0 |        28 |      20.3 |  0.598 |
| 330305   | digital, scan+text                    | docling-tess-nocells |    246 |      41037 |       43 | [1]    |         65 |      0 |        28 |      20.1 |  0.725 |
| 330305   | digital, scan+text                    | docling-tess-noreng  |    246 |      44762 |       43 | [1]    |         65 |      0 |        28 |      20.4 |  0.706 |
| 330305   | digital, scan+text                    | docling-tess-repair  |    246 |      44762 |       43 | [1]    |         65 |      0 |        28 |      20.4 |  0.641 |
| 372605   | digital, scan+text                    | docling-tess         |    123 |      25201 |       20 | [1]    |         11 |      1 |        27 |      31.4 |  1.006 |
| 372605   | digital, scan+text                    | docling-tess-best    |    123 |      25210 |       20 | [1]    |         11 |      1 |        27 |      31.4 |  1.167 |
| 372605   | digital, scan+text                    | docling-tess-egret   |    128 |      25281 |       20 | [1]    |         11 |      1 |        24 |      31.2 |  0.939 |
| 372605   | digital, scan+text                    | docling-tess-nocells |    123 |      25263 |       20 | [1]    |         11 |      1 |        27 |      31.3 |  0.995 |
| 372605   | digital, scan+text                    | docling-tess-noreng  |    124 |      25198 |       20 | [1]    |         11 |      1 |        27 |      31.3 |  1.136 |
| 372605   | digital, scan+text                    | docling-tess-repair  |    123 |      25201 |       20 | [1]    |         11 |      1 |        27 |      31.4 |  0.949 |
| 51059    | digital                               | docling-tess         |    204 |      47855 |       30 | [1]    |          0 |      2 |        41 |       1.4 |  1.527 |
| 51059    | digital                               | docling-tess-best    |    203 |      47904 |       30 | [1]    |          0 |      2 |        41 |       0.6 |  1.462 |
| 51059    | digital                               | docling-tess-egret   |    192 |      47911 |       30 | [1]    |          0 |      3 |        39 |       1.6 |    1.4 |
| 51059    | digital                               | docling-tess-nocells |    204 |      46738 |       30 | [1]    |          0 |      2 |        41 |       1.4 |  1.411 |
| 51059    | digital                               | docling-tess-noreng  |    204 |      47906 |       30 | [1]    |          0 |      2 |        41 |       0.6 |  1.473 |
| 51059    | digital                               | docling-tess-repair  |    204 |      47855 |       30 | [1]    |          0 |      2 |        41 |       1.4 |  1.458 |
| 5418     | image-only, scan+text                 | docling-tess         |    185 |      49494 |       24 | [1]    |         38 |      0 |        18 |       0.1 |  0.702 |
| 5418     | image-only, scan+text                 | docling-tess-best    |    184 |      49497 |       24 | [1]    |         38 |      0 |        18 |       0.1 |  0.768 |
| 5418     | image-only, scan+text                 | docling-tess-egret   |    175 |      49561 |       22 | [1]    |         38 |      0 |        16 |       0.1 |  0.673 |
| 5418     | image-only, scan+text                 | docling-tess-nocells |    185 |      49296 |       24 | [1]    |         38 |      0 |        18 |       0.1 |  0.702 |
| 5418     | image-only, scan+text                 | docling-tess-noreng  |    185 |      49497 |       24 | [1]    |         38 |      0 |        18 |       0.1 |  0.744 |
| 5418     | image-only, scan+text                 | docling-tess-repair  |    185 |      49494 |       24 | [1]    |         38 |      0 |        18 |       0.1 |  0.707 |
| 355302   | digital                               | docling-tess         |    441 |      60628 |       43 | [1]    |        118 |      8 |        86 |      20.1 |   1.95 |
| 355302   | digital                               | docling-tess-best    |    441 |      60720 |       43 | [1]    |        118 |      8 |        86 |      20.4 |  2.272 |
| 355302   | digital                               | docling-tess-egret   |    467 |      60840 |       48 | [1]    |        112 |     12 |        87 |      20.2 |   1.91 |
| 355302   | digital                               | docling-tess-nocells |    441 |      60295 |       43 | [1]    |        118 |      8 |        86 |      20.2 |  1.927 |
| 355302   | digital                               | docling-tess-noreng  |    441 |      60644 |       43 | [1]    |        118 |      8 |        86 |      20.0 |  2.109 |
| 355302   | digital                               | docling-tess-repair  |    441 |      60628 |       43 | [1]    |        118 |      8 |        86 |      20.1 |   1.95 |
| 46870    | digital, image-only                   | docling-tess         |    177 |      44210 |       27 | [1]    |         20 |      4 |        17 |      17.1 |   0.97 |
| 46870    | digital, image-only                   | docling-tess-best    |    176 |      44230 |       27 | [1]    |         20 |      4 |        17 |      17.1 |  0.956 |
| 46870    | digital, image-only                   | docling-tess-egret   |    177 |      44000 |       25 | [1]    |         20 |      4 |        17 |      17.1 |  0.938 |
| 46870    | digital, image-only                   | docling-tess-nocells |    177 |      43148 |       27 | [1]    |         20 |      4 |        17 |      17.0 |  0.948 |
| 46870    | digital, image-only                   | docling-tess-noreng  |    178 |      44214 |       27 | [1]    |         20 |      4 |        17 |      17.1 |  0.993 |
| 46870    | digital, image-only                   | docling-tess-repair  |    177 |      44210 |       27 | [1]    |         20 |      4 |        17 |      17.1 |  0.943 |
| 19582    | digital                               | docling-tess         |    367 |      88977 |       34 | [1]    |         35 |      0 |        89 |      20.0 |  0.485 |
| 19582    | digital                               | docling-tess-best    |    369 |      88983 |       34 | [1]    |         35 |      0 |        89 |      20.0 |  0.372 |
| 19582    | digital                               | docling-tess-egret   |    474 |      88602 |       34 | [1]    |         37 |      0 |        93 |      20.0 |  0.375 |
| 19582    | digital                               | docling-tess-nocells |    367 |      88658 |       34 | [1]    |         35 |      0 |        89 |      20.0 |  0.374 |
| 19582    | digital                               | docling-tess-noreng  |    369 |      88987 |       34 | [1]    |         35 |      0 |        89 |      20.0 |  0.373 |
| 19582    | digital                               | docling-tess-repair  |    367 |      88977 |       34 | [1]    |         35 |      0 |        89 |      20.0 |   0.38 |
| 75814    | image-only                            | docling-tess         |    248 |      56570 |       53 | [1]    |          0 |     18 |        25 |      25.9 |  3.118 |
| 75814    | image-only                            | docling-tess-best    |    253 |      55945 |       53 | [1]    |          0 |     18 |        25 |      26.2 |  3.795 |
| 75814    | image-only                            | docling-tess-egret   |    288 |      56400 |       55 | [1]    |          0 |     17 |        25 |      26.0 |  3.081 |
| 75814    | image-only                            | docling-tess-nocells |    248 |      55711 |       53 | [1]    |          0 |     18 |        25 |      26.0 |  3.107 |
| 75814    | image-only                            | docling-tess-noreng  |    248 |      56645 |       53 | [1]    |          0 |     18 |        25 |      25.0 |  3.531 |
| 75814    | image-only                            | docling-tess-repair  |    248 |      56570 |       53 | [1]    |          0 |     18 |        25 |      25.9 |  3.102 |
| 31196    | digital, scan+text                    | docling-tess         |    470 |      84831 |       85 | [1]    |         45 |      3 |       136 |      16.1 |   0.51 |
| 31196    | digital, scan+text                    | docling-tess-best    |    470 |      84831 |       85 | [1]    |         45 |      3 |       136 |      16.1 |  0.431 |
| 31196    | digital, scan+text                    | docling-tess-egret   |    463 |      84592 |       86 | [1]    |         43 |      3 |       136 |      16.1 |   0.37 |
| 31196    | digital, scan+text                    | docling-tess-nocells |    470 |      84454 |       85 | [1]    |         45 |      3 |       136 |      16.1 |  0.408 |
| 31196    | digital, scan+text                    | docling-tess-noreng  |    470 |      84831 |       85 | [1]    |         45 |      3 |       136 |      16.1 |  0.444 |
| 31196    | digital, scan+text                    | docling-tess-repair  |    470 |      84831 |       85 | [1]    |         45 |      3 |       136 |      16.1 |  0.411 |
| 19557    | digital                               | docling-tess         |    497 |     130217 |      100 | [1]    |         11 |      0 |        97 |      22.3 |  0.513 |
| 19557    | digital                               | docling-tess-best    |    499 |     130219 |      100 | [1]    |         11 |      0 |        97 |      22.3 |  0.405 |
| 19557    | digital                               | docling-tess-egret   |    511 |     130225 |       99 | [1]    |         11 |      0 |       107 |      22.3 |  0.383 |
| 19557    | digital                               | docling-tess-nocells |    497 |     130178 |      100 | [1]    |         11 |      0 |        97 |      22.3 |  0.396 |
| 19557    | digital                               | docling-tess-noreng  |    497 |     130223 |      100 | [1]    |         11 |      0 |        97 |      22.3 |  0.404 |
| 19557    | digital                               | docling-tess-repair  |    497 |     130217 |      100 | [1]    |         11 |      0 |        97 |      22.3 |  0.405 |
| 102474   | digital, image-only                   | docling-tess         |   1140 |     139760 |      156 | [1]    |         92 |     51 |       394 |      19.0 |  2.181 |
| 102474   | digital, image-only                   | docling-tess-best    |   1142 |     139776 |      156 | [1]    |         92 |     51 |       394 |      19.0 |  2.328 |
| 102474   | digital, image-only                   | docling-tess-egret   |   1012 |     149930 |      166 | [1]    |        146 |     50 |       100 |      18.4 |  2.093 |
| 102474   | digital, image-only                   | docling-tess-nocells |   1140 |     139056 |      156 | [1]    |         92 |     51 |       394 |      19.0 |  2.174 |
| 102474   | digital, image-only                   | docling-tess-noreng  |   1140 |     139771 |      156 | [1]    |         92 |     51 |       394 |      19.0 |  2.273 |
| 102474   | digital, image-only                   | docling-tess-repair  |   1140 |     139760 |      156 | [1]    |         92 |     51 |       394 |      19.0 |  2.175 |
| 8a1cc78e | scan+text, image-only, digital        | docling-tess         |    752 |     175649 |       87 | [1]    |         26 |     35 |       127 |      22.6 |  3.091 |
| 8a1cc78e | scan+text, image-only, digital        | docling-tess-best    |    756 |     175696 |       87 | [1]    |         26 |     35 |       127 |      22.9 |  4.418 |
| 8a1cc78e | scan+text, image-only, digital        | docling-tess-egret   |    781 |     175948 |       97 | [1]    |         30 |     35 |       118 |      22.5 |  3.058 |
| 8a1cc78e | scan+text, image-only, digital        | docling-tess-nocells |    752 |     171175 |       87 | [1]    |         26 |     35 |       127 |      22.9 |  3.101 |
| 8a1cc78e | scan+text, image-only, digital        | docling-tess-noreng  |    753 |     175724 |       87 | [1]    |         26 |     35 |       127 |      22.4 |  3.422 |
| 8a1cc78e | scan+text, image-only, digital        | docling-tess-repair  |    752 |     175649 |       87 | [1]    |         26 |     35 |       127 |      22.6 |  3.038 |
| e87e4ace | image-only                            | docling-tess         |     71 |       4742 |       14 | [1]    |         25 |      0 |         5 |      17.3 |  3.217 |
| e87e4ace | image-only                            | docling-tess-best    |     70 |       4729 |       14 | [1]    |         23 |      0 |         5 |      17.3 |  4.434 |
| e87e4ace | image-only                            | docling-tess-egret   |     72 |       4745 |       14 | [1]    |         25 |      0 |         5 |      17.3 |  2.651 |
| e87e4ace | image-only                            | docling-tess-nocells |     71 |       4742 |       14 | [1]    |         25 |      0 |         5 |      17.3 |  3.229 |
| e87e4ace | image-only                            | docling-tess-noreng  |     66 |       4730 |       14 | [1]    |         21 |      0 |         5 |      16.7 |  3.623 |
| e87e4ace | image-only                            | docling-tess-repair  |     71 |       4742 |       14 | [1]    |         25 |      0 |         5 |      17.3 |  3.207 |
| 504fb542 | digital                               | docling-tess         |     90 |      15016 |       16 | [1]    |         16 |      2 |        20 |      11.5 |  0.565 |
| 504fb542 | digital                               | docling-tess-best    |     91 |      15018 |       16 | [1]    |         16 |      2 |        20 |      11.5 |  0.463 |
| 504fb542 | digital                               | docling-tess-egret   |     92 |      15030 |       12 | [1]    |         16 |      2 |        20 |      11.5 |  0.506 |
| 504fb542 | digital                               | docling-tess-nocells |     90 |      15016 |       16 | [1]    |         16 |      2 |        20 |      11.5 |  0.454 |
| 504fb542 | digital                               | docling-tess-noreng  |     90 |      15018 |       16 | [1]    |         16 |      2 |        20 |      11.5 |  0.463 |
| 504fb542 | digital                               | docling-tess-repair  |     90 |      15016 |       16 | [1]    |         16 |      2 |        20 |      11.5 |  0.448 |
| e9bad2e8 | scan+text, image-only                 | docling-tess         |    778 |     130654 |       93 | [1]    |        113 |     16 |        67 |       1.9 |  6.815 |
| e9bad2e8 | scan+text, image-only                 | docling-tess-best    |    783 |     130845 |       93 | [1]    |        112 |     16 |        67 |       1.9 |  8.057 |
| e9bad2e8 | scan+text, image-only                 | docling-tess-egret   |    694 |     130031 |       90 | [1]    |        166 |     18 |        60 |       1.6 |  6.775 |
| e9bad2e8 | scan+text, image-only                 | docling-tess-nocells |    778 |     130526 |       93 | [1]    |        113 |     16 |        67 |       1.8 |  6.799 |
| e9bad2e8 | scan+text, image-only                 | docling-tess-noreng  |    790 |     130604 |       93 | [1]    |        113 |     16 |        67 |       0.6 |  7.666 |
| e9bad2e8 | scan+text, image-only                 | docling-tess-repair  |    778 |     130654 |       93 | [1]    |        113 |     16 |        67 |       1.9 |  6.822 |
| f4585a45 | digital                               | docling-tess         |    101 |       9163 |       16 | [1]    |         31 |      0 |         6 |      30.4 |  0.448 |
| f4585a45 | digital                               | docling-tess-best    |    101 |       9163 |       16 | [1]    |         31 |      0 |         6 |      30.4 |   0.33 |
| f4585a45 | digital                               | docling-tess-egret   |     88 |       9192 |       13 | [1]    |         31 |      0 |         5 |      30.4 |  0.357 |
| f4585a45 | digital                               | docling-tess-nocells |    101 |       9163 |       16 | [1]    |         31 |      0 |         6 |      30.4 |  0.328 |
| f4585a45 | digital                               | docling-tess-noreng  |    101 |       9163 |       16 | [1]    |         31 |      0 |         6 |      30.4 |  0.324 |
| f4585a45 | digital                               | docling-tess-repair  |    101 |       9163 |       16 | [1]    |         31 |      0 |         6 |      30.4 |  0.325 |
| 47b5d29b | digital                               | docling-tess         |     96 |       9132 |       14 | [1]    |         30 |      0 |         6 |      29.4 |  0.431 |
| 47b5d29b | digital                               | docling-tess-best    |     96 |       9132 |       14 | [1]    |         30 |      0 |         6 |      29.4 |  0.334 |
| 47b5d29b | digital                               | docling-tess-egret   |     87 |       9174 |       15 | [1]    |         30 |      0 |         6 |      29.4 |  0.355 |
| 47b5d29b | digital                               | docling-tess-nocells |     96 |       9132 |       14 | [1]    |         30 |      0 |         6 |      29.4 |  0.328 |
| 47b5d29b | digital                               | docling-tess-noreng  |     96 |       9132 |       14 | [1]    |         30 |      0 |         6 |      29.4 |  0.325 |
| 47b5d29b | digital                               | docling-tess-repair  |     96 |       9132 |       14 | [1]    |         30 |      0 |         6 |      29.4 |  0.326 |
| 63ec8679 | image-only                            | docling-tess         |    223 |      37875 |       92 | [1]    |         20 |      0 |         9 |      22.5 |  2.585 |
| 63ec8679 | image-only                            | docling-tess-best    |    223 |      37760 |       92 | [1]    |         20 |      0 |         9 |      22.6 |  3.504 |
| 63ec8679 | image-only                            | docling-tess-egret   |    224 |      37912 |       91 | [1]    |         20 |      0 |         8 |      22.5 |  2.675 |
| 63ec8679 | image-only                            | docling-tess-nocells |    223 |      37863 |       92 | [1]    |         20 |      0 |         9 |      22.5 |  2.531 |
| 63ec8679 | image-only                            | docling-tess-noreng  |    222 |      37857 |       92 | [1]    |         20 |      0 |         9 |      22.4 |  2.818 |
| 63ec8679 | image-only                            | docling-tess-repair  |    223 |      37875 |       92 | [1]    |         20 |      0 |         9 |      22.5 |  2.558 |
| b3ffd2a8 | scan+text, digital                    | docling-tess         |    795 |     141865 |      100 | [1]    |         10 |      0 |        40 |       0.7 |  3.563 |
| b3ffd2a8 | scan+text, digital                    | docling-tess-best    |    801 |     141886 |      100 | [1]    |         10 |      0 |        40 |       0.7 |  4.229 |
| b3ffd2a8 | scan+text, digital                    | docling-tess-egret   |    751 |     141997 |       98 | [1]    |         12 |      1 |        33 |       0.7 |  3.777 |
| b3ffd2a8 | scan+text, digital                    | docling-tess-nocells |    795 |     141865 |      100 | [1]    |         10 |      0 |        40 |       0.7 |  3.561 |
| b3ffd2a8 | scan+text, digital                    | docling-tess-noreng  |    793 |     141859 |      100 | [1]    |         10 |      0 |        40 |       0.7 |  3.762 |
| b3ffd2a8 | scan+text, digital                    | docling-tess-repair  |    795 |     141865 |      100 | [1]    |         10 |      0 |        40 |       0.7 |  3.585 |
| 71965693 | digital                               | docling-tess         |    382 |      52860 |       56 | [1]    |         29 |     24 |        82 |      18.2 |  1.098 |
| 71965693 | digital                               | docling-tess-best    |    382 |      52946 |       56 | [1]    |         29 |     24 |        82 |      18.2 |  1.163 |
| 71965693 | digital                               | docling-tess-egret   |    383 |      51609 |       54 | [1]    |         29 |     25 |        84 |      18.0 |  1.702 |
| 71965693 | digital                               | docling-tess-nocells |    382 |      52528 |       56 | [1]    |         29 |     24 |        82 |      18.5 |  1.061 |
| 71965693 | digital                               | docling-tess-noreng  |    382 |      52858 |       56 | [1]    |         29 |     24 |        82 |      18.2 |  1.147 |
| 71965693 | digital                               | docling-tess-repair  |    382 |      52860 |       56 | [1]    |         29 |     24 |        82 |      18.2 |  1.065 |
| c083beda | blank, digital                        | docling-tess         |    420 |      85413 |       49 | [1]    |         21 |     23 |        63 |       0.9 |  2.698 |
| c083beda | blank, digital                        | docling-tess-best    |    420 |      85413 |       49 | [1]    |         21 |     23 |        63 |       0.8 |   2.69 |
| c083beda | blank, digital                        | docling-tess-egret   |    370 |      85201 |       49 | [1]    |         20 |     28 |        68 |       0.9 |  2.685 |
| c083beda | blank, digital                        | docling-tess-nocells |    420 |      81109 |       49 | [1]    |         21 |     23 |        63 |       1.0 |  2.661 |
| c083beda | blank, digital                        | docling-tess-noreng  |    420 |      85416 |       49 | [1]    |         21 |     23 |        63 |       0.8 |  2.753 |
| c083beda | blank, digital                        | docling-tess-repair  |    420 |      85413 |       49 | [1]    |         21 |     23 |        63 |       0.9 |  2.694 |
| 34783e9d | digital                               | docling-tess         |    768 |     172892 |       91 | [1]    |         59 |     32 |       175 |      19.8 |  1.033 |
| 34783e9d | digital                               | docling-tess-best    |    768 |     172886 |       91 | [1]    |         59 |     32 |       175 |      19.8 |  0.988 |
| 34783e9d | digital                               | docling-tess-egret   |    821 |     173865 |       98 | [1]    |         56 |     32 |       190 |      19.8 |  0.936 |
| 34783e9d | digital                               | docling-tess-nocells |    768 |     170846 |       91 | [1]    |         59 |     32 |       175 |      19.9 |  0.985 |
| 34783e9d | digital                               | docling-tess-noreng  |    768 |     172901 |       91 | [1]    |         59 |     32 |       175 |      19.8 |  0.984 |
| 34783e9d | digital                               | docling-tess-repair  |    768 |     172892 |       91 | [1]    |         59 |     32 |       175 |      19.8 |  0.985 |
| 40178058 | digital, blank                        | docling-tess         |    439 |     105760 |       70 | [1]    |         48 |     19 |        39 |      24.4 |  0.895 |
| 40178058 | digital, blank                        | docling-tess-best    |    441 |     105812 |       70 | [1]    |         48 |     19 |        39 |      24.5 |  0.815 |
| 40178058 | digital, blank                        | docling-tess-egret   |    418 |     105522 |       79 | [1]    |         68 |     17 |        40 |      24.5 |   0.75 |
| 40178058 | digital, blank                        | docling-tess-nocells |    439 |     105520 |       70 | [1]    |         48 |     19 |        39 |      24.4 |  0.803 |
| 40178058 | digital, blank                        | docling-tess-noreng  |    438 |     105778 |       70 | [1]    |         48 |     19 |        39 |      24.2 |   0.84 |
| 40178058 | digital, blank                        | docling-tess-repair  |    439 |     105760 |       70 | [1]    |         48 |     19 |        39 |      24.4 |  0.797 |
| 810ca2af | image-only, digital, blank            | docling-tess         |    692 |     179807 |       51 | [1]    |         38 |     17 |       134 |      20.7 |  0.516 |
| 810ca2af | image-only, digital, blank            | docling-tess-best    |    692 |     179811 |       51 | [1]    |         38 |     17 |       134 |      20.7 |   0.44 |
| 810ca2af | image-only, digital, blank            | docling-tess-egret   |    689 |     179779 |       50 | [1]    |         37 |     17 |       135 |      20.7 |  0.409 |
| 810ca2af | image-only, digital, blank            | docling-tess-nocells |    692 |     179807 |       51 | [1]    |         38 |     17 |       134 |      20.7 |  0.439 |
| 810ca2af | image-only, digital, blank            | docling-tess-noreng  |    693 |     179813 |       51 | [1]    |         38 |     17 |       134 |      20.7 |   0.44 |
| 810ca2af | image-only, digital, blank            | docling-tess-repair  |    692 |     179807 |       51 | [1]    |         38 |     17 |       134 |      20.7 |  0.439 |
| 7ca7961d | digital, scan+text, blank, image-only | docling-tess         |    654 |      78229 |       77 | [1]    |         48 |     10 |       114 |      16.1 |  0.744 |
| 7ca7961d | digital, scan+text, blank, image-only | docling-tess-best    |    652 |      78204 |       77 | [1]    |         48 |     10 |       114 |      16.2 |  0.852 |
| 7ca7961d | digital, scan+text, blank, image-only | docling-tess-egret   |    610 |      79147 |       73 | [1]    |         97 |     10 |        67 |      16.0 |  0.788 |
| 7ca7961d | digital, scan+text, blank, image-only | docling-tess-nocells |    654 |      78603 |       77 | [1]    |         48 |     10 |       114 |      16.0 |   0.73 |
| 7ca7961d | digital, scan+text, blank, image-only | docling-tess-noreng  |    648 |      78269 |       77 | [1]    |         48 |     10 |       114 |      15.9 |  0.873 |
| 7ca7961d | digital, scan+text, blank, image-only | docling-tess-repair  |    654 |      78229 |       77 | [1]    |         48 |     10 |       114 |      16.1 |  0.749 |
| 36e2d1d0 | digital                               | docling-tess         |    314 |      32115 |       63 | [1]    |         27 |      4 |        14 |      14.1 |  0.546 |
| 36e2d1d0 | digital                               | docling-tess-best    |    314 |      32115 |       63 | [1]    |         27 |      4 |        14 |      14.1 |  0.434 |
| 36e2d1d0 | digital                               | docling-tess-egret   |    312 |      31870 |       54 | [1]    |         41 |      3 |        16 |      14.1 |  0.387 |
| 36e2d1d0 | digital                               | docling-tess-nocells |    314 |      32087 |       63 | [1]    |         27 |      4 |        14 |      14.1 |  0.417 |
| 36e2d1d0 | digital                               | docling-tess-noreng  |    314 |      32115 |       63 | [1]    |         27 |      4 |        14 |      14.1 |  0.429 |
| 36e2d1d0 | digital                               | docling-tess-repair  |    314 |      32115 |       63 | [1]    |         27 |      4 |        14 |      14.1 |  0.433 |
| 73e413c8 | digital, blank                        | docling-tess         |    193 |      32956 |       27 | [1]    |         33 |      4 |        39 |      16.3 |  0.629 |
| 73e413c8 | digital, blank                        | docling-tess-best    |    195 |      32962 |       27 | [1]    |         33 |      4 |        39 |      16.5 |  0.534 |
| 73e413c8 | digital, blank                        | docling-tess-egret   |    206 |      32581 |       25 | [1]    |         37 |      4 |        35 |      16.4 |  0.524 |
| 73e413c8 | digital, blank                        | docling-tess-nocells |    193 |      32836 |       27 | [1]    |         33 |      4 |        39 |      16.4 |  0.503 |
| 73e413c8 | digital, blank                        | docling-tess-noreng  |    193 |      32953 |       27 | [1]    |         33 |      4 |        39 |      16.0 |  0.541 |
| 73e413c8 | digital, blank                        | docling-tess-repair  |    193 |      32956 |       27 | [1]    |         33 |      4 |        39 |      16.3 |  0.512 |
| d6e0e88b | digital, blank                        | docling-tess         |    152 |      34907 |       22 | [1]    |         29 |      0 |        36 |       1.7 |  0.517 |
| d6e0e88b | digital, blank                        | docling-tess-best    |    152 |      34909 |       22 | [1]    |         29 |      0 |        36 |       1.7 |  0.457 |
| d6e0e88b | digital, blank                        | docling-tess-egret   |    168 |      34964 |       21 | [1]    |         27 |      0 |        39 |       1.7 |  0.414 |
| d6e0e88b | digital, blank                        | docling-tess-nocells |    152 |      34931 |       22 | [1]    |         29 |      0 |        36 |       1.7 |  0.441 |
| d6e0e88b | digital, blank                        | docling-tess-noreng  |    152 |      34907 |       22 | [1]    |         29 |      0 |        36 |       1.7 |  0.463 |
| d6e0e88b | digital, blank                        | docling-tess-repair  |    152 |      34907 |       22 | [1]    |         29 |      0 |        36 |       1.7 |  0.427 |
| 5cb6ee7a | digital                               | docling-tess         |    232 |      62927 |       26 | [1]    |         22 |      0 |        16 |      19.5 |  0.518 |
| 5cb6ee7a | digital                               | docling-tess-best    |    232 |      62927 |       26 | [1]    |         22 |      0 |        16 |      19.5 |  0.396 |
| 5cb6ee7a | digital                               | docling-tess-egret   |    227 |      62765 |       28 | [1]    |         17 |      0 |        16 |      19.5 |  0.381 |
| 5cb6ee7a | digital                               | docling-tess-nocells |    232 |      62845 |       26 | [1]    |         22 |      0 |        16 |      19.5 |  0.395 |
| 5cb6ee7a | digital                               | docling-tess-noreng  |    232 |      62927 |       26 | [1]    |         22 |      0 |        16 |      19.5 |  0.413 |
| 5cb6ee7a | digital                               | docling-tess-repair  |    232 |      62927 |       26 | [1]    |         22 |      0 |        16 |      19.5 |  0.413 |
| d17a8877 | image-only, digital, scan+text, blank | docling-tess         |   1591 |     181748 |      161 | [1]    |         34 |     47 |       122 |      20.9 |  4.443 |
| d17a8877 | image-only, digital, scan+text, blank | docling-tess-best    |   1623 |     181993 |      161 | [1]    |         34 |     47 |       122 |      21.1 |  4.907 |
| d17a8877 | image-only, digital, scan+text, blank | docling-tess-egret   |   1559 |     175949 |      170 | [1]    |         35 |     48 |       121 |      21.3 |  4.537 |
| d17a8877 | image-only, digital, scan+text, blank | docling-tess-nocells |   1592 |     175311 |      161 | [1]    |         34 |     47 |       122 |      21.4 |  4.513 |
| d17a8877 | image-only, digital, scan+text, blank | docling-tess-noreng  |   1614 |     181897 |      161 | [1]    |         34 |     47 |       122 |      20.3 |  4.743 |
| d17a8877 | image-only, digital, scan+text, blank | docling-tess-repair  |   1591 |     181748 |      161 | [1]    |         34 |     47 |       122 |      20.9 |  4.478 |
| 93050f9c | image-only                            | docling-tess         |    317 |      69854 |       19 | [1]    |          7 |     34 |        35 |      17.4 |  3.461 |
| 93050f9c | image-only                            | docling-tess-best    |    317 |      69762 |       19 | [1]    |          7 |     34 |        35 |      17.4 |  4.415 |
| 93050f9c | image-only                            | docling-tess-egret   |    292 |      69861 |       27 | [1]    |          7 |     34 |        35 |      17.3 |  3.431 |
| 93050f9c | image-only                            | docling-tess-nocells |    317 |      69774 |       19 | [1]    |          7 |     34 |        35 |      17.3 |  3.487 |
| 93050f9c | image-only                            | docling-tess-noreng  |    317 |      69828 |       19 | [1]    |          7 |     34 |        35 |      17.1 |  3.821 |
| 93050f9c | image-only                            | docling-tess-repair  |    317 |      69854 |       19 | [1]    |          7 |     34 |        35 |      17.4 |  3.472 |
| d71c0286 | digital                               | docling-tess         |     37 |      13812 |        7 | [1]    |          5 |      8 |         0 |       0.1 |  5.777 |
| d71c0286 | digital                               | docling-tess-best    |     37 |      13817 |        7 | [1]    |          5 |      8 |         0 |       0.4 |  5.807 |
| d71c0286 | digital                               | docling-tess-egret   |     38 |      13836 |        8 | [1]    |          5 |      8 |         0 |       0.9 |  5.677 |
| d71c0286 | digital                               | docling-tess-nocells |     37 |      13750 |        7 | [1]    |          5 |      8 |         0 |       0.1 |  5.706 |
| d71c0286 | digital                               | docling-tess-noreng  |     37 |      13808 |        7 | [1]    |          5 |      8 |         0 |       0.1 |  5.742 |
| d71c0286 | digital                               | docling-tess-repair  |     37 |      13812 |        7 | [1]    |          5 |      8 |         0 |       0.1 |  5.679 |
| cc081a8d | digital, blank                        | docling-tess         |    186 |      38168 |       32 | [1]    |         30 |      3 |        39 |      20.7 |  0.652 |
| cc081a8d | digital, blank                        | docling-tess-best    |    188 |      38190 |       32 | [1]    |         30 |      3 |        39 |      20.9 |  0.636 |
| cc081a8d | digital, blank                        | docling-tess-egret   |    213 |      37743 |       31 | [1]    |         33 |      3 |        41 |      20.9 |  0.566 |
| cc081a8d | digital, blank                        | docling-tess-nocells |    186 |      38053 |       32 | [1]    |         30 |      3 |        39 |      20.8 |  0.632 |
| cc081a8d | digital, blank                        | docling-tess-noreng  |    186 |      38173 |       32 | [1]    |         30 |      3 |        39 |      20.7 |  0.636 |
| cc081a8d | digital, blank                        | docling-tess-repair  |    186 |      38168 |       32 | [1]    |         30 |      3 |        39 |      20.7 |  0.631 |
| 7c683b2a | digital, blank                        | docling-tess         |    427 |      99128 |       75 | [1]    |         43 |      1 |        40 |      30.0 |  0.482 |
| 7c683b2a | digital, blank                        | docling-tess-best    |    427 |      99141 |       75 | [1]    |         43 |      1 |        40 |      30.1 |  0.387 |
| 7c683b2a | digital, blank                        | docling-tess-egret   |    435 |      98469 |       72 | [1]    |         48 |      0 |        40 |      30.0 |  0.356 |
| 7c683b2a | digital, blank                        | docling-tess-nocells |    427 |      98555 |       75 | [1]    |         43 |      1 |        40 |      30.1 |  0.368 |
| 7c683b2a | digital, blank                        | docling-tess-noreng  |    427 |      99130 |       75 | [1]    |         43 |      1 |        40 |      30.0 |  0.375 |
| 7c683b2a | digital, blank                        | docling-tess-repair  |    427 |      99128 |       75 | [1]    |         43 |      1 |        40 |      30.0 |   0.37 |
| 7d136c1c | digital                               | docling-tess         |    149 |      29769 |       45 | [1]    |          7 |      0 |        12 |      17.0 |   0.58 |
| 7d136c1c | digital                               | docling-tess-best    |    149 |      29769 |       45 | [1]    |          7 |      0 |        12 |      17.0 |   0.52 |
| 7d136c1c | digital                               | docling-tess-egret   |    149 |      29886 |       45 | [1]    |          7 |      0 |        12 |      17.0 |  0.527 |
| 7d136c1c | digital                               | docling-tess-nocells |    149 |      28965 |       45 | [1]    |          7 |      0 |        12 |      17.0 |  0.521 |
| 7d136c1c | digital                               | docling-tess-noreng  |    149 |      29769 |       45 | [1]    |          7 |      0 |        12 |      17.0 |   0.52 |
| 7d136c1c | digital                               | docling-tess-repair  |    149 |      29769 |       45 | [1]    |          7 |      0 |        12 |      17.0 |  0.527 |
