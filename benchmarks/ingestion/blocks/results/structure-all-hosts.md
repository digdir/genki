# Block structure: docling, docling-no, docling-rapid, docling-tess, marker, marker2, mineru, mineru-noimg

Run folders: .data/runs/azure-NC4as_T4_v3-francecentral, .data/runs/azure-NC24ads_A100_v4-swedencentral, .data/runs/azure-D8as_v6-swedencentral. Counts from `blocks.jsonl`; see `normalise.py` for the block format and `compare.py` for each column.

## Per parser, all documents

| Parser        | Documents | Blocks | Characters | Headings | Heading levels  | List items | Tables | Furniture | Empty | æøå per 1,000 letters |
| ------------- | --------: | -----: | ---------: | -------: | --------------- | ---------: | -----: | --------: | ----: | --------------------: |
| docling       |        15 |   4282 |     789942 |      659 | [1]             |        464 |     92 |       976 |    10 |         16.1 (median) |
| docling-no    |        15 |   4277 |     789214 |      660 | [1]             |        456 |     92 |       976 |    10 |         19.8 (median) |
| docling-rapid |        15 |   4311 |     796120 |      661 | [1]             |        477 |     92 |       987 |    10 |         19.7 (median) |
| docling-tess  |        15 |   4315 |     801838 |      662 | [1]             |        477 |     92 |       971 |    10 |         20.0 (median) |
| marker        |        15 |   4209 |     756375 |      671 | [1, 2, 3, 4]    |        383 |    116 |       753 |    67 |         20.0 (median) |
| marker2       |        15 |   4148 |     757127 |      708 | [1, 2, 3, 4, 5] |        206 |    157 |      1048 |    61 |         20.1 (median) |
| mineru        |        15 |   4278 |     762161 |      627 | [2]             |          0 |    122 |       915 |     0 |         20.0 (median) |
| mineru-noimg  |        15 |   4278 |     762161 |      627 | [2]             |          0 |    122 |       915 |     0 |         20.0 (median) |

## Seconds per page

| Parser        |                azure-NC4as_T4_v3-francecentral |            azure-NC24ads_A100_v4-swedencentral | azure-D8as_v6-swedencentral |
| ------------- | ---------------------------------------------: | ---------------------------------------------: | --------------------------: |
| docling       |  0.61 (332 pages, GPU peak 8829 MiB, 46% busy) | 0.40 (332 pages, GPU peak 12046 MiB, 27% busy) |            4.75 (332 pages) |
| docling-no    |  0.61 (332 pages, GPU peak 7351 MiB, 48% busy) | 0.40 (332 pages, GPU peak 12074 MiB, 33% busy) |            4.80 (332 pages) |
| docling-rapid |   1.26 (332 pages, GPU peak 1859 MiB, 9% busy) |   0.77 (332 pages, GPU peak 2162 MiB, 7% busy) |            2.02 (332 pages) |
| docling-tess  |  1.18 (332 pages, GPU peak 1727 MiB, 10% busy) |   0.96 (332 pages, GPU peak 2194 MiB, 5% busy) |            1.61 (332 pages) |
| marker        | 4.15 (332 pages, GPU peak 10193 MiB, 78% busy) | 1.54 (332 pages, GPU peak 10160 MiB, 56% busy) |            62.59 (31 pages) |
| marker2       | 2.77 (332 pages, GPU peak 15843 MiB, 45% busy) | 0.64 (332 pages, GPU peak 72275 MiB, 21% busy) |                           – |
| mineru        |  0.89 (332 pages, GPU peak 7699 MiB, 31% busy) | 0.45 (332 pages, GPU peak 11173 MiB, 12% busy) |                           – |
| mineru-noimg  |  0.89 (332 pages, GPU peak 7879 MiB, 45% busy) | 0.44 (332 pages, GPU peak 11173 MiB, 16% busy) |                           – |

## Per document

| Document | Pages                 | Parser        | Blocks | Characters | Headings | Levels          | List items | Tables | Furniture | æøå/1,000 | s/page |
| -------- | --------------------- | ------------- | -----: | ---------: | -------: | --------------- | ---------: | -----: | --------: | --------: | -----: |
| 33245    | digital               | docling       |     33 |       2088 |        4 | [1]             |          2 |      3 |         4 |      13.1 |   0.67 |
| 33245    | digital               | docling-no    |     33 |       2088 |        4 | [1]             |          2 |      3 |         4 |      13.1 |  0.674 |
| 33245    | digital               | docling-rapid |     33 |       2093 |        4 | [1]             |          2 |      3 |         4 |      13.1 |  1.141 |
| 33245    | digital               | docling-tess  |     34 |       2097 |        4 | [1]             |          2 |      3 |         4 |      13.1 |  1.125 |
| 33245    | digital               | marker        |     28 |       1918 |        6 | [1, 3, 4]       |          0 |      2 |         7 |      14.2 |  0.945 |
| 33245    | digital               | marker2       |     30 |       2055 |        7 | [1, 2, 3]       |          0 |      2 |         6 |      13.7 |  5.006 |
| 33245    | digital               | mineru        |     32 |       2175 |        6 | [2]             |          0 |      2 |         2 |      11.6 |  0.976 |
| 33245    | digital               | mineru-noimg  |     32 |       2175 |        6 | [2]             |          0 |      2 |         2 |      11.6 |  0.976 |
| 339679   | digital               | docling       |     61 |      12288 |       16 | [1]             |          1 |      2 |         5 |      19.7 |  0.199 |
| 339679   | digital               | docling-no    |     61 |      12288 |       16 | [1]             |          1 |      2 |         5 |      19.8 |  0.202 |
| 339679   | digital               | docling-rapid |     61 |      12289 |       16 | [1]             |          1 |      2 |         5 |      19.7 |  0.286 |
| 339679   | digital               | docling-tess  |     62 |      12298 |       16 | [1]             |          1 |      2 |         5 |      19.8 |  0.233 |
| 339679   | digital               | marker        |     60 |      12165 |       16 | [1, 3, 4]       |          0 |      3 |         5 |      19.4 |  0.808 |
| 339679   | digital               | marker2       |     63 |      11609 |       17 | [1, 2, 3, 4]    |          0 |      3 |         5 |      20.1 |  1.129 |
| 339679   | digital               | mineru        |     66 |      11618 |       18 | [2]             |          0 |      2 |         6 |      19.6 |   0.79 |
| 339679   | digital               | mineru-noimg  |     66 |      11618 |       18 | [2]             |          0 |      2 |         6 |      19.6 |   0.79 |
| 8562     | image-only            | docling       |     61 |       6902 |       11 | [1]             |         25 |      0 |         2 |       0.0 |  1.805 |
| 8562     | image-only            | docling-no    |     61 |       7029 |       11 | [1]             |         25 |      0 |         2 |      21.2 |  1.828 |
| 8562     | image-only            | docling-rapid |     63 |       7060 |       11 | [1]             |         25 |      0 |         4 |      21.5 |  2.917 |
| 8562     | image-only            | docling-tess  |     60 |       7076 |       12 | [1]             |         25 |      0 |         0 |      21.4 |  2.831 |
| 8562     | image-only            | marker        |     61 |       7120 |       11 | [1, 2, 3, 4]    |         23 |      0 |         4 |      21.5 | 16.229 |
| 8562     | image-only            | marker2       |     44 |       7157 |       11 | [1, 2]          |          0 |      0 |         4 |      21.5 |  5.799 |
| 8562     | image-only            | mineru        |     61 |       7126 |       12 | [2]             |          0 |      0 |         4 |      21.1 |  1.666 |
| 8562     | image-only            | mineru-noimg  |     61 |       7126 |       12 | [2]             |          0 |      0 |         4 |      21.1 |  1.631 |
| 5944     | scan+text             | docling       |     60 |       7835 |       14 | [1]             |         14 |      0 |         4 |       0.0 |  1.114 |
| 5944     | scan+text             | docling-no    |     60 |       7690 |       14 | [1]             |         14 |      0 |         4 |      21.8 |  1.133 |
| 5944     | scan+text             | docling-rapid |     60 |       7783 |       14 | [1]             |         14 |      0 |         4 |      21.8 |  3.956 |
| 5944     | scan+text             | docling-tess  |     61 |       7862 |       15 | [1]             |         14 |      0 |         4 |      22.2 |  3.684 |
| 5944     | scan+text             | marker        |     61 |       7919 |       14 | [1, 2, 4]       |         14 |      0 |         4 |      22.2 |  0.836 |
| 5944     | scan+text             | marker2       |     50 |       7767 |       14 | [1, 2, 4]       |          2 |      0 |         4 |      22.3 |  0.719 |
| 5944     | scan+text             | mineru        |     62 |       7875 |       14 | [2]             |          0 |      0 |         4 |      20.8 |  1.369 |
| 5944     | scan+text             | mineru-noimg  |     62 |       7875 |       14 | [2]             |          0 |      0 |         4 |      20.8 |   1.37 |
| 330305   | digital, scan+text    | docling       |    246 |      44712 |       43 | [1]             |         65 |      0 |        28 |      19.4 |  0.305 |
| 330305   | digital, scan+text    | docling-no    |    246 |      44696 |       43 | [1]             |         65 |      0 |        28 |      20.4 |  0.311 |
| 330305   | digital, scan+text    | docling-rapid |    246 |      44405 |       43 | [1]             |         65 |      0 |        28 |      20.5 |  0.538 |
| 330305   | digital, scan+text    | docling-tess  |    246 |      44762 |       43 | [1]             |         65 |      0 |        28 |      20.4 |  0.458 |
| 330305   | digital, scan+text    | marker        |    219 |      36298 |       47 | [1, 2, 4]       |         32 |      1 |        30 |      20.8 |   0.84 |
| 330305   | digital, scan+text    | marker2       |    211 |      38626 |       46 | [1, 3, 4]       |         19 |      1 |        30 |      20.9 |  0.835 |
| 330305   | digital, scan+text    | mineru        |    245 |      35745 |       44 | [2]             |          0 |      0 |        30 |      20.8 |  1.982 |
| 330305   | digital, scan+text    | mineru-noimg  |    245 |      35745 |       44 | [2]             |          0 |      0 |        30 |      20.8 |  1.977 |
| 372605   | digital, scan+text    | docling       |    123 |      25326 |       20 | [1]             |         11 |      1 |        27 |      30.9 |   0.59 |
| 372605   | digital, scan+text    | docling-no    |    123 |      25284 |       20 | [1]             |         11 |      1 |        27 |      31.0 |  0.599 |
| 372605   | digital, scan+text    | docling-rapid |    123 |      25369 |       20 | [1]             |         11 |      1 |        27 |      31.1 |    1.8 |
| 372605   | digital, scan+text    | docling-tess  |    123 |      25201 |       20 | [1]             |         11 |      1 |        27 |      31.4 |  1.079 |
| 372605   | digital, scan+text    | marker        |    129 |      22923 |       27 | [1, 2, 3, 4]    |         11 |      4 |        17 |      31.7 |  7.703 |
| 372605   | digital, scan+text    | marker2       |    113 |      23907 |       18 | [1, 2, 3]       |          0 |      2 |        27 |      31.7 |   2.09 |
| 372605   | digital, scan+text    | mineru        |    131 |      22713 |       17 | [2]             |          0 |      1 |        29 |      31.7 |  0.418 |
| 372605   | digital, scan+text    | mineru-noimg  |    131 |      22713 |       17 | [2]             |          0 |      1 |        29 |      31.7 |  0.418 |
| 51059    | digital               | docling       |    203 |      46825 |       30 | [1]             |          0 |      2 |        42 |       0.1 |  0.609 |
| 51059    | digital               | docling-no    |    203 |      46681 |       30 | [1]             |          0 |      2 |        42 |       0.2 |  0.609 |
| 51059    | digital               | docling-rapid |    212 |      48405 |       30 | [1]             |          0 |      2 |        42 |       0.1 |  1.627 |
| 51059    | digital               | docling-tess  |    204 |      47855 |       30 | [1]             |          0 |      2 |        41 |       1.4 |  1.086 |
| 51059    | digital               | marker        |    206 |      34767 |       30 | [1, 2, 4]       |          0 |      3 |        57 |       0.2 |  1.183 |
| 51059    | digital               | marker2       |    166 |      33527 |       31 | [1, 2, 3]       |          2 |      5 |        44 |       0.2 |  1.282 |
| 51059    | digital               | mineru        |    202 |      33470 |       31 | [2]             |          0 |      2 |        50 |       0.2 |  0.664 |
| 51059    | digital               | mineru-noimg  |    202 |      33470 |       31 | [2]             |          0 |      2 |        50 |       0.2 |  0.664 |
| 5418     | image-only, scan+text | docling       |    172 |      49436 |       24 | [1]             |         38 |      0 |        18 |       0.0 |  0.414 |
| 5418     | image-only, scan+text | docling-no    |    170 |      49425 |       24 | [1]             |         38 |      0 |        18 |       0.0 |  0.422 |
| 5418     | image-only, scan+text | docling-rapid |    172 |      49439 |       24 | [1]             |         38 |      0 |        18 |       0.0 |  0.669 |
| 5418     | image-only, scan+text | docling-tess  |    185 |      49494 |       24 | [1]             |         38 |      0 |        18 |       0.1 |  0.755 |
| 5418     | image-only, scan+text | marker        |    153 |      45470 |       20 | [1, 2, 3, 4]    |         21 |      1 |        13 |       0.0 |  0.756 |
| 5418     | image-only, scan+text | marker2       |    178 |      47130 |       25 | [1, 2, 3, 4]    |         39 |      2 |        22 |       0.0 |  0.481 |
| 5418     | image-only, scan+text | mineru        |    201 |      47551 |       23 | [2]             |          0 |      0 |        16 |       0.0 |  0.398 |
| 5418     | image-only, scan+text | mineru-noimg  |    201 |      47551 |       23 | [2]             |          0 |      0 |        16 |       0.0 |  0.399 |
| 355302   | digital               | docling       |    435 |      58314 |       43 | [1]             |        105 |      8 |        81 |      11.1 |  0.965 |
| 355302   | digital               | docling-no    |    428 |      58664 |       43 | [1]             |         97 |      8 |        81 |      19.4 |  0.967 |
| 355302   | digital               | docling-rapid |    425 |      58684 |       43 | [1]             |        118 |      8 |        81 |      19.3 |  1.958 |
| 355302   | digital               | docling-tess  |    441 |      60628 |       43 | [1]             |        118 |      8 |        86 |      20.1 |  1.566 |
| 355302   | digital               | marker        |    431 |      56604 |       43 | [1, 2, 3, 4]    |         87 |      9 |        75 |      20.0 |  3.789 |
| 355302   | digital               | marker2       |    366 |      58967 |       55 | [1, 2, 3, 4]    |         10 |      9 |        89 |      20.3 |  3.304 |
| 355302   | digital               | mineru        |    426 |      57840 |       38 | [2]             |          0 |      8 |        93 |      20.4 |   1.12 |
| 355302   | digital               | mineru-noimg  |    426 |      57840 |       38 | [2]             |          0 |      8 |        93 |      20.4 |   1.11 |
| 46870    | digital, image-only   | docling       |    176 |      44234 |       27 | [1]             |         20 |      4 |        17 |      17.1 |  0.485 |
| 46870    | digital, image-only   | docling-no    |    177 |      44241 |       27 | [1]             |         20 |      4 |        17 |      17.1 |   0.49 |
| 46870    | digital, image-only   | docling-rapid |    181 |      44346 |       27 | [1]             |         20 |      4 |        17 |      17.0 |  0.547 |
| 46870    | digital, image-only   | docling-tess  |    177 |      44210 |       27 | [1]             |         20 |      4 |        17 |      17.1 |   1.02 |
| 46870    | digital, image-only   | marker        |    187 |      39924 |       26 | [1, 2, 3, 4]    |         18 |      5 |        17 |      17.1 |  0.995 |
| 46870    | digital, image-only   | marker2       |    181 |      38629 |       26 | [1, 2, 3, 4]    |         20 |      5 |        17 |      17.2 |   1.55 |
| 46870    | digital, image-only   | mineru        |    176 |      40596 |       24 | [2]             |          0 |      4 |        17 |      17.2 |  0.422 |
| 46870    | digital, image-only   | mineru-noimg  |    176 |      40596 |       24 | [2]             |          0 |      4 |        17 |      17.2 |  0.424 |
| 19582    | digital               | docling       |    365 |      88965 |       34 | [1]             |         35 |      0 |        89 |      20.0 |  0.092 |
| 19582    | digital               | docling-no    |    365 |      88965 |       34 | [1]             |         35 |      0 |        89 |      20.0 |  0.091 |
| 19582    | digital               | docling-rapid |    365 |      88974 |       34 | [1]             |         35 |      0 |        89 |      20.0 |  0.129 |
| 19582    | digital               | docling-tess  |    367 |      88977 |       34 | [1]             |         35 |      0 |        89 |      20.0 |  0.118 |
| 19582    | digital               | marker        |    403 |      88585 |       39 | [1, 2, 3, 4]    |         18 |      5 |        50 |      20.0 |  0.885 |
| 19582    | digital               | marker2       |    349 |      88468 |       39 | [1, 2, 3, 4]    |          0 |      2 |        98 |      20.0 |  4.594 |
| 19582    | digital               | mineru        |    370 |      87832 |       39 | [2]             |          0 |      0 |        81 |      20.0 |  0.565 |
| 19582    | digital               | mineru-noimg  |    370 |      87832 |       39 | [2]             |          0 |      0 |        81 |      20.0 |  0.568 |
| 75814    | image-only            | docling       |    246 |      48249 |       52 | [1]             |          0 |     18 |        32 |       0.0 |  1.495 |
| 75814    | image-only            | docling-no    |    249 |      47359 |       53 | [1]             |          0 |     18 |        32 |      27.9 |  1.484 |
| 75814    | image-only            | docling-rapid |    258 |      52054 |       54 | [1]             |          0 |     18 |        34 |      26.0 |  4.359 |
| 75814    | image-only            | docling-tess  |    248 |      56570 |       53 | [1]             |          0 |     18 |        25 |      25.9 |  3.767 |
| 75814    | image-only            | marker        |    267 |      47258 |       54 | [1, 2, 3]       |          0 |     19 |        36 |      25.3 |  5.442 |
| 75814    | image-only            | marker2       |    271 |      54070 |       60 | [1, 2, 3, 4]    |          0 |     21 |        35 |      27.0 |  3.531 |
| 75814    | image-only            | mineru        |    262 |      55827 |       40 | [2]             |          0 |     18 |        37 |      26.1 |  1.492 |
| 75814    | image-only            | mineru-noimg  |    262 |      55827 |       40 | [2]             |          0 |     18 |        37 |      26.1 |  1.491 |
| 31196    | digital, scan+text    | docling       |    472 |      84839 |       85 | [1]             |         45 |      3 |       136 |      16.1 |  0.137 |
| 31196    | digital, scan+text    | docling-no    |    472 |      84839 |       85 | [1]             |         45 |      3 |       136 |      16.1 |  0.134 |
| 31196    | digital, scan+text    | docling-rapid |    470 |      84835 |       85 | [1]             |         45 |      3 |       136 |      16.1 |  0.233 |
| 31196    | digital, scan+text    | docling-tess  |    470 |      84831 |       85 | [1]             |         45 |      3 |       136 |      16.1 |  0.185 |
| 31196    | digital, scan+text    | marker        |    479 |      82674 |       86 | [1, 2, 3, 4]    |         35 |      5 |       140 |      16.2 |  0.792 |
| 31196    | digital, scan+text    | marker2       |    465 |      81078 |       90 | [1, 2, 3]       |         35 |      5 |       138 |      16.4 |  2.042 |
| 31196    | digital, scan+text    | mineru        |    481 |      82022 |       87 | [2]             |          0 |      3 |       142 |      16.2 |  0.693 |
| 31196    | digital, scan+text    | mineru-noimg  |    481 |      82022 |       87 | [2]             |          0 |      3 |       142 |      16.2 |  0.689 |
| 19557    | digital               | docling       |    493 |     130185 |      100 | [1]             |         11 |      0 |        97 |      22.3 |  0.135 |
| 19557    | digital               | docling-no    |    493 |     130183 |      100 | [1]             |         11 |      0 |        97 |      22.3 |  0.133 |
| 19557    | digital               | docling-rapid |    493 |     130185 |      100 | [1]             |         11 |      0 |        97 |      22.3 |  0.158 |
| 19557    | digital               | docling-tess  |    497 |     130217 |      100 | [1]             |         11 |      0 |        97 |      22.3 |   0.15 |
| 19557    | digital               | marker        |    498 |     129309 |      101 | [1, 2, 3, 4]    |         11 |      5 |        60 |      22.4 |  0.886 |
| 19557    | digital               | marker2       |    540 |     129152 |       98 | [1, 2, 3, 4, 5] |          0 |      1 |       117 |      22.3 |  5.175 |
| 19557    | digital               | mineru        |    524 |     128397 |       99 | [2]             |          0 |      0 |        98 |      22.3 |   0.65 |
| 19557    | digital               | mineru-noimg  |    524 |     128397 |       99 | [2]             |          0 |      0 |        98 |      22.3 |  0.652 |
| 102474   | digital, image-only   | docling       |   1136 |     139744 |      156 | [1]             |         92 |     51 |       394 |      18.9 |  1.095 |
| 102474   | digital, image-only   | docling-no    |   1136 |     139782 |      156 | [1]             |         92 |     51 |       394 |      19.0 |  1.156 |
| 102474   | digital, image-only   | docling-rapid |   1149 |     140199 |      156 | [1]             |         92 |     51 |       401 |      18.9 |  1.462 |
| 102474   | digital, image-only   | docling-tess  |   1140 |     139760 |      156 | [1]             |         92 |     51 |       394 |      19.0 |  1.853 |
| 102474   | digital, image-only   | marker        |   1027 |     143441 |      151 | [1, 3, 4]       |        113 |     54 |       238 |      18.3 | 16.765 |
| 102474   | digital, image-only   | marker2       |   1121 |     134985 |      171 | [1, 2, 3, 4]    |         79 |     99 |       412 |      19.3 |  2.679 |
| 102474   | digital, image-only   | mineru        |   1039 |     141374 |      135 | [2]             |          0 |     82 |       306 |      18.6 |  1.274 |
| 102474   | digital, image-only   | mineru-noimg  |   1039 |     141374 |      135 | [2]             |          0 |     82 |       306 |      18.6 |  1.285 |
