# Block structure: docling, docling-no, docling-rapid, docling-tess, marker, marker2, mineru, mineru-noimg

Run folders: /home/azureuser/blocks/.data/runs/azure-NC24ads_A100_v4-swedencentral. Counts from `blocks.jsonl`; see `normalise.py` for the block format and `compare.py` for each column.

## Per parser, all documents

| Parser | Documents | Blocks | Characters | Headings | Heading levels | List items | Tables | Furniture | Empty | æøå per 1,000 letters |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| docling | 15 | 4281 | 790426 | 659 | [1] | 464 | 92 | 976 | 10 | 16.1 (median) |
| docling-no | 15 | 4276 | 789866 | 660 | [1] | 456 | 92 | 976 | 10 | 19.8 (median) |
| docling-rapid | 15 | 4309 | 796638 | 661 | [1] | 477 | 92 | 987 | 10 | 19.7 (median) |
| docling-tess | 15 | 4314 | 802346 | 662 | [1] | 477 | 92 | 971 | 10 | 20.0 (median) |
| marker | 15 | 4220 | 754655 | 673 | [1, 2, 3, 4] | 385 | 113 | 756 | 82 | 20.0 (median) |
| marker2 | 15 | 4163 | 756812 | 708 | [1, 2, 3, 4, 5] | 214 | 156 | 1050 | 66 | 20.1 (median) |
| mineru | 15 | 4278 | 762131 | 626 | [2] | 0 | 122 | 915 | 0 | 20.0 (median) |
| mineru-noimg | 15 | 4278 | 762131 | 626 | [2] | 0 | 122 | 915 | 0 | 20.0 (median) |

## Seconds per page

| Parser | azure-NC24ads_A100_v4-swedencentral |
| --- | ---: |
| docling | 0.40 (332 pages, GPU peak 12046 MiB, 27% busy) |
| docling-no | 0.40 (332 pages, GPU peak 12074 MiB, 33% busy) |
| docling-rapid | 0.77 (332 pages, GPU peak 2162 MiB, 7% busy) |
| docling-tess | 0.96 (332 pages, GPU peak 2194 MiB, 5% busy) |
| marker | 1.54 (332 pages, GPU peak 10160 MiB, 56% busy) |
| marker2 | 0.64 (332 pages, GPU peak 72275 MiB, 21% busy) |
| mineru | 0.45 (332 pages, GPU peak 11173 MiB, 12% busy) |
| mineru-noimg | 0.44 (332 pages, GPU peak 11173 MiB, 16% busy) |

## Per document

| Document | Pages | Parser | Blocks | Characters | Headings | Levels | List items | Tables | Furniture | æøå/1,000 | s/page |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 33245 | digital | docling | 33 | 2088 | 4 | [1] | 2 | 3 | 4 | 13.1 | 0.503 |
| 33245 | digital | docling-no | 33 | 2088 | 4 | [1] | 2 | 3 | 4 | 13.1 | 0.497 |
| 33245 | digital | docling-rapid | 33 | 2093 | 4 | [1] | 2 | 3 | 4 | 13.1 | 0.736 |
| 33245 | digital | docling-tess | 34 | 2097 | 4 | [1] | 2 | 3 | 4 | 13.1 | 0.926 |
| 33245 | digital | marker | 28 | 1922 | 6 | [1, 2, 3, 4] | 0 | 2 | 7 | 14.2 | 0.521 |
| 33245 | digital | marker2 | 30 | 2055 | 7 | [1, 2, 3] | 0 | 2 | 6 | 13.7 | 2.313 |
| 33245 | digital | mineru | 32 | 2175 | 6 | [2] | 0 | 2 | 2 | 11.6 | 0.688 |
| 33245 | digital | mineru-noimg | 32 | 2175 | 6 | [2] | 0 | 2 | 2 | 11.6 | 0.675 |
| 339679 | digital | docling | 61 | 12288 | 16 | [1] | 1 | 2 | 5 | 19.7 | 0.144 |
| 339679 | digital | docling-no | 61 | 12288 | 16 | [1] | 1 | 2 | 5 | 19.8 | 0.144 |
| 339679 | digital | docling-rapid | 61 | 12289 | 16 | [1] | 1 | 2 | 5 | 19.7 | 0.217 |
| 339679 | digital | docling-tess | 62 | 12298 | 16 | [1] | 1 | 2 | 5 | 19.8 | 0.197 |
| 339679 | digital | marker | 60 | 12095 | 16 | [1, 2, 4] | 0 | 3 | 5 | 19.5 | 0.398 |
| 339679 | digital | marker2 | 63 | 11598 | 17 | [1, 2, 4] | 0 | 3 | 5 | 20.1 | 0.629 |
| 339679 | digital | mineru | 66 | 11618 | 18 | [2] | 0 | 2 | 6 | 19.6 | 0.531 |
| 339679 | digital | mineru-noimg | 66 | 11618 | 18 | [2] | 0 | 2 | 6 | 19.6 | 0.525 |
| 8562 | image-only | docling | 61 | 6902 | 11 | [1] | 25 | 0 | 2 | 0.0 | 1.278 |
| 8562 | image-only | docling-no | 61 | 7121 | 11 | [1] | 25 | 0 | 2 | 21.6 | 1.289 |
| 8562 | image-only | docling-rapid | 63 | 7060 | 11 | [1] | 25 | 0 | 4 | 21.5 | 1.712 |
| 8562 | image-only | docling-tess | 60 | 7076 | 12 | [1] | 25 | 0 | 0 | 21.4 | 2.391 |
| 8562 | image-only | marker | 61 | 7120 | 11 | [1, 2, 3, 4] | 23 | 0 | 4 | 21.5 | 6.18 |
| 8562 | image-only | marker2 | 44 | 7157 | 11 | [1, 2] | 0 | 0 | 4 | 21.5 | 1.857 |
| 8562 | image-only | mineru | 61 | 7126 | 12 | [2] | 0 | 0 | 4 | 21.1 | 0.75 |
| 8562 | image-only | mineru-noimg | 61 | 7126 | 12 | [2] | 0 | 0 | 4 | 21.1 | 0.712 |
| 5944 | scan+text | docling | 60 | 7835 | 14 | [1] | 14 | 0 | 4 | 0.0 | 0.777 |
| 5944 | scan+text | docling-no | 60 | 7690 | 14 | [1] | 14 | 0 | 4 | 21.8 | 0.79 |
| 5944 | scan+text | docling-rapid | 60 | 7783 | 14 | [1] | 14 | 0 | 4 | 21.8 | 2.418 |
| 5944 | scan+text | docling-tess | 61 | 7862 | 15 | [1] | 14 | 0 | 4 | 22.2 | 3.136 |
| 5944 | scan+text | marker | 61 | 7925 | 14 | [1, 2, 3, 4] | 14 | 0 | 4 | 22.2 | 0.372 |
| 5944 | scan+text | marker2 | 50 | 7766 | 14 | [1, 2, 4] | 2 | 0 | 4 | 22.3 | 0.339 |
| 5944 | scan+text | mineru | 62 | 7875 | 14 | [2] | 0 | 0 | 4 | 20.8 | 0.571 |
| 5944 | scan+text | mineru-noimg | 62 | 7875 | 14 | [2] | 0 | 0 | 4 | 20.8 | 0.568 |
| 330305 | digital, scan+text | docling | 246 | 44739 | 43 | [1] | 65 | 0 | 28 | 19.4 | 0.201 |
| 330305 | digital, scan+text | docling-no | 246 | 44696 | 43 | [1] | 65 | 0 | 28 | 20.4 | 0.202 |
| 330305 | digital, scan+text | docling-rapid | 246 | 44405 | 43 | [1] | 65 | 0 | 28 | 20.5 | 0.311 |
| 330305 | digital, scan+text | docling-tess | 246 | 44762 | 43 | [1] | 65 | 0 | 28 | 20.4 | 0.358 |
| 330305 | digital, scan+text | marker | 219 | 36297 | 47 | [1, 2, 4] | 32 | 1 | 30 | 20.8 | 0.364 |
| 330305 | digital, scan+text | marker2 | 211 | 38626 | 46 | [1, 2, 3, 4] | 19 | 1 | 30 | 20.9 | 0.306 |
| 330305 | digital, scan+text | mineru | 245 | 35745 | 44 | [2] | 0 | 0 | 30 | 20.8 | 0.698 |
| 330305 | digital, scan+text | mineru-noimg | 245 | 35745 | 44 | [2] | 0 | 0 | 30 | 20.8 | 0.686 |
| 372605 | digital, scan+text | docling | 123 | 25326 | 20 | [1] | 11 | 1 | 27 | 30.9 | 0.4 |
| 372605 | digital, scan+text | docling-no | 123 | 25284 | 20 | [1] | 11 | 1 | 27 | 31.0 | 0.398 |
| 372605 | digital, scan+text | docling-rapid | 123 | 25369 | 20 | [1] | 11 | 1 | 27 | 31.1 | 1.064 |
| 372605 | digital, scan+text | docling-tess | 123 | 25201 | 20 | [1] | 11 | 1 | 27 | 31.4 | 0.938 |
| 372605 | digital, scan+text | marker | 129 | 22997 | 28 | [1, 2, 3, 4] | 11 | 4 | 17 | 31.6 | 2.603 |
| 372605 | digital, scan+text | marker2 | 113 | 23930 | 18 | [1, 2, 3] | 0 | 2 | 27 | 31.7 | 0.637 |
| 372605 | digital, scan+text | mineru | 131 | 22713 | 17 | [2] | 0 | 1 | 29 | 31.7 | 0.286 |
| 372605 | digital, scan+text | mineru-noimg | 131 | 22713 | 17 | [2] | 0 | 1 | 29 | 31.7 | 0.29 |
| 51059 | digital | docling | 202 | 46848 | 30 | [1] | 0 | 2 | 42 | 0.1 | 0.47 |
| 51059 | digital | docling-no | 202 | 46689 | 30 | [1] | 0 | 2 | 42 | 0.2 | 0.477 |
| 51059 | digital | docling-rapid | 211 | 48404 | 30 | [1] | 0 | 2 | 42 | 0.1 | 0.959 |
| 51059 | digital | docling-tess | 203 | 47854 | 30 | [1] | 0 | 2 | 41 | 1.4 | 0.81 |
| 51059 | digital | marker | 206 | 35021 | 30 | [1, 2, 4] | 0 | 3 | 57 | 0.2 | 0.614 |
| 51059 | digital | marker2 | 168 | 33532 | 31 | [1, 2, 3] | 2 | 5 | 46 | 0.2 | 0.5 |
| 51059 | digital | mineru | 202 | 33471 | 31 | [2] | 0 | 2 | 50 | 0.2 | 0.361 |
| 51059 | digital | mineru-noimg | 202 | 33471 | 31 | [2] | 0 | 2 | 50 | 0.2 | 0.366 |
| 5418 | image-only, scan+text | docling | 172 | 49436 | 24 | [1] | 38 | 0 | 18 | 0.0 | 0.199 |
| 5418 | image-only, scan+text | docling-no | 170 | 49425 | 24 | [1] | 38 | 0 | 18 | 0.0 | 0.199 |
| 5418 | image-only, scan+text | docling-rapid | 172 | 49439 | 24 | [1] | 38 | 0 | 18 | 0.0 | 0.43 |
| 5418 | image-only, scan+text | docling-tess | 185 | 49494 | 24 | [1] | 38 | 0 | 18 | 0.1 | 0.642 |
| 5418 | image-only, scan+text | marker | 153 | 45395 | 20 | [1, 2, 3, 4] | 21 | 1 | 13 | 0.0 | 0.334 |
| 5418 | image-only, scan+text | marker2 | 188 | 46760 | 25 | [1, 2, 3] | 40 | 1 | 23 | 0.0 | 0.197 |
| 5418 | image-only, scan+text | mineru | 201 | 47551 | 23 | [2] | 0 | 0 | 16 | 0.0 | 0.286 |
| 5418 | image-only, scan+text | mineru-noimg | 201 | 47551 | 23 | [2] | 0 | 0 | 16 | 0.0 | 0.286 |
| 355302 | digital | docling | 435 | 58236 | 43 | [1] | 105 | 8 | 81 | 11.1 | 0.75 |
| 355302 | digital | docling-no | 428 | 58664 | 43 | [1] | 97 | 8 | 81 | 19.4 | 0.754 |
| 355302 | digital | docling-rapid | 425 | 58684 | 43 | [1] | 118 | 8 | 81 | 19.3 | 1.114 |
| 355302 | digital | docling-tess | 441 | 60628 | 43 | [1] | 118 | 8 | 86 | 20.1 | 1.293 |
| 355302 | digital | marker | 433 | 57066 | 44 | [1, 3, 4] | 90 | 9 | 76 | 20.0 | 1.58 |
| 355302 | digital | marker2 | 366 | 58973 | 55 | [1, 2, 3, 4] | 10 | 9 | 89 | 20.3 | 0.906 |
| 355302 | digital | mineru | 426 | 57838 | 38 | [2] | 0 | 8 | 93 | 20.4 | 0.627 |
| 355302 | digital | mineru-noimg | 426 | 57838 | 38 | [2] | 0 | 8 | 93 | 20.4 | 0.62 |
| 46870 | digital, image-only | docling | 176 | 44234 | 27 | [1] | 20 | 4 | 17 | 17.1 | 0.192 |
| 46870 | digital, image-only | docling-no | 177 | 44241 | 27 | [1] | 20 | 4 | 17 | 17.1 | 0.188 |
| 46870 | digital, image-only | docling-rapid | 181 | 44346 | 27 | [1] | 20 | 4 | 17 | 17.0 | 0.339 |
| 46870 | digital, image-only | docling-tess | 177 | 44210 | 27 | [1] | 20 | 4 | 17 | 17.1 | 0.861 |
| 46870 | digital, image-only | marker | 187 | 39393 | 26 | [1, 2, 3, 4] | 18 | 5 | 17 | 17.2 | 0.386 |
| 46870 | digital, image-only | marker2 | 182 | 38581 | 26 | [1, 2, 3, 4] | 20 | 5 | 18 | 17.3 | 0.561 |
| 46870 | digital, image-only | mineru | 176 | 40598 | 24 | [2] | 0 | 4 | 17 | 17.2 | 0.262 |
| 46870 | digital, image-only | mineru-noimg | 176 | 40598 | 24 | [2] | 0 | 4 | 17 | 17.2 | 0.261 |
| 19582 | digital | docling | 365 | 88965 | 34 | [1] | 35 | 0 | 89 | 20.0 | 0.055 |
| 19582 | digital | docling-no | 365 | 88965 | 34 | [1] | 35 | 0 | 89 | 20.0 | 0.054 |
| 19582 | digital | docling-rapid | 365 | 88974 | 34 | [1] | 35 | 0 | 89 | 20.0 | 0.085 |
| 19582 | digital | docling-tess | 367 | 88977 | 34 | [1] | 35 | 0 | 89 | 20.0 | 0.071 |
| 19582 | digital | marker | 401 | 88608 | 39 | [1, 2, 3, 4] | 18 | 5 | 50 | 20.0 | 0.381 |
| 19582 | digital | marker2 | 349 | 88469 | 39 | [1, 2, 3, 4] | 0 | 2 | 98 | 20.0 | 0.744 |
| 19582 | digital | mineru | 370 | 87832 | 39 | [2] | 0 | 0 | 81 | 20.0 | 0.405 |
| 19582 | digital | mineru-noimg | 370 | 87832 | 39 | [2] | 0 | 0 | 81 | 20.0 | 0.401 |
| 75814 | image-only | docling | 246 | 48269 | 52 | [1] | 0 | 18 | 32 | 0.0 | 1.026 |
| 75814 | image-only | docling-no | 249 | 47421 | 53 | [1] | 0 | 18 | 32 | 27.9 | 1.035 |
| 75814 | image-only | docling-rapid | 258 | 52080 | 54 | [1] | 0 | 18 | 34 | 26.0 | 2.646 |
| 75814 | image-only | docling-tess | 248 | 56581 | 53 | [1] | 0 | 18 | 25 | 25.9 | 3.108 |
| 75814 | image-only | marker | 266 | 49150 | 54 | [1, 2, 3] | 0 | 19 | 35 | 24.1 | 3.764 |
| 75814 | image-only | marker2 | 271 | 54105 | 60 | [1, 2, 3, 4] | 0 | 21 | 35 | 27.1 | 0.637 |
| 75814 | image-only | mineru | 262 | 55798 | 40 | [2] | 0 | 18 | 37 | 26.2 | 0.445 |
| 75814 | image-only | mineru-noimg | 262 | 55798 | 40 | [2] | 0 | 18 | 37 | 26.2 | 0.434 |
| 31196 | digital, scan+text | docling | 472 | 84839 | 85 | [1] | 45 | 3 | 136 | 16.1 | 0.085 |
| 31196 | digital, scan+text | docling-no | 472 | 84839 | 85 | [1] | 45 | 3 | 136 | 16.1 | 0.087 |
| 31196 | digital, scan+text | docling-rapid | 470 | 84835 | 85 | [1] | 45 | 3 | 136 | 16.1 | 0.146 |
| 31196 | digital, scan+text | docling-tess | 470 | 84831 | 85 | [1] | 45 | 3 | 136 | 16.1 | 0.149 |
| 31196 | digital, scan+text | marker | 479 | 82416 | 86 | [1, 2, 3, 4] | 35 | 5 | 139 | 16.1 | 0.311 |
| 31196 | digital, scan+text | marker2 | 465 | 81077 | 90 | [1, 2, 3] | 35 | 5 | 138 | 16.4 | 0.48 |
| 31196 | digital, scan+text | mineru | 481 | 82022 | 87 | [2] | 0 | 3 | 142 | 16.2 | 0.393 |
| 31196 | digital, scan+text | mineru-noimg | 481 | 82022 | 87 | [2] | 0 | 3 | 142 | 16.2 | 0.387 |
| 19557 | digital | docling | 493 | 130185 | 100 | [1] | 11 | 0 | 97 | 22.3 | 0.082 |
| 19557 | digital | docling-no | 493 | 130183 | 100 | [1] | 11 | 0 | 97 | 22.3 | 0.084 |
| 19557 | digital | docling-rapid | 493 | 130185 | 100 | [1] | 11 | 0 | 97 | 22.3 | 0.101 |
| 19557 | digital | docling-tess | 497 | 130217 | 100 | [1] | 11 | 0 | 97 | 22.3 | 0.113 |
| 19557 | digital | marker | 496 | 129228 | 100 | [1, 2, 3, 4] | 11 | 5 | 61 | 22.4 | 0.398 |
| 19557 | digital | marker2 | 540 | 129148 | 98 | [1, 2, 3, 4, 5] | 0 | 1 | 117 | 22.3 | 0.756 |
| 19557 | digital | mineru | 524 | 128397 | 99 | [2] | 0 | 0 | 98 | 22.3 | 0.438 |
| 19557 | digital | mineru-noimg | 524 | 128397 | 99 | [2] | 0 | 0 | 98 | 22.3 | 0.436 |
| 102474 | digital, image-only | docling | 1136 | 140236 | 156 | [1] | 92 | 51 | 394 | 18.9 | 0.718 |
| 102474 | digital, image-only | docling-no | 1136 | 140272 | 156 | [1] | 92 | 51 | 394 | 18.9 | 0.726 |
| 102474 | digital, image-only | docling-rapid | 1148 | 140692 | 156 | [1] | 92 | 51 | 401 | 18.8 | 0.971 |
| 102474 | digital, image-only | docling-tess | 1140 | 140258 | 156 | [1] | 92 | 51 | 394 | 18.9 | 1.482 |
| 102474 | digital, image-only | marker | 1041 | 140022 | 152 | [1, 3, 4] | 112 | 51 | 241 | 19.0 | 4.487 |
| 102474 | digital, image-only | marker2 | 1123 | 135035 | 171 | [1, 2, 3, 4] | 86 | 99 | 410 | 19.3 | 0.789 |
| 102474 | digital, image-only | mineru | 1039 | 141372 | 134 | [2] | 0 | 82 | 306 | 18.6 | 0.608 |
| 102474 | digital, image-only | mineru-noimg | 1039 | 141372 | 134 | [2] | 0 | 82 | 306 | 18.6 | 0.601 |
