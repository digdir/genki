# Block structure: marker, marker-strip

Run folders: /home/azureuser/blocks/.data/runs/azure-NC4as_T4_v3-francecentral-run2. Counts from `blocks.jsonl`; see `normalise.py` for the block format and `compare.py` for each column.

## Per parser, all documents

| Parser | Documents | Blocks | Characters | Headings | Heading levels | List items | Tables | Furniture | Empty | æøå per 1,000 letters |
| --- | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| marker | 39 | 13047 | 2490873 | 2031 | [1, 2, 3, 4] | 1139 | 443 | 1871 | 242 | 19.4 (median) |
| marker-strip | 39 | 13040 | 2489646 | 2031 | [1, 2, 3, 4] | 1139 | 443 | 1871 | 230 | 19.4 (median) |

## Seconds per page

| Parser | azure-NC4as_T4_v3-francecentral-run2 |
| --- | ---: |
| marker | 3.95 (1100 pages, GPU peak 11683 MiB, 80% busy) |
| marker-strip | 5.18 (1100 pages, GPU peak 10351 MiB, 82% busy) |

## Per document

| Document | Pages | Parser | Blocks | Characters | Headings | Levels | List items | Tables | Furniture | æøå/1,000 | s/page |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 33245 | digital | marker | 28 | 1918 | 6 | [1, 3, 4] | 0 | 2 | 7 | 14.2 | 0.935 |
| 33245 | digital | marker-strip | 28 | 1918 | 6 | [1, 3, 4] | 0 | 2 | 7 | 14.2 | 1.081 |
| 339679 | digital | marker | 60 | 12165 | 16 | [1, 3, 4] | 0 | 3 | 5 | 19.4 | 0.808 |
| 339679 | digital | marker-strip | 60 | 12165 | 16 | [1, 3, 4] | 0 | 3 | 5 | 19.4 | 0.832 |
| 8562 | image-only | marker | 61 | 7120 | 11 | [1, 2, 3, 4] | 23 | 0 | 4 | 21.5 | 16.242 |
| 8562 | image-only | marker-strip | 61 | 7120 | 11 | [1, 2, 3, 4] | 23 | 0 | 4 | 21.5 | 16.973 |
| 5944 | scan+text | marker | 61 | 7919 | 14 | [1, 2, 4] | 14 | 0 | 4 | 22.2 | 0.829 |
| 5944 | scan+text | marker-strip | 60 | 7865 | 14 | [1, 2, 4] | 14 | 0 | 4 | 22.1 | 16.948 |
| 330305 | digital, scan+text | marker | 219 | 36298 | 47 | [1, 2, 4] | 32 | 1 | 30 | 20.8 | 0.828 |
| 330305 | digital, scan+text | marker-strip | 219 | 36302 | 47 | [1, 2, 4] | 32 | 1 | 30 | 20.8 | 2.946 |
| 372605 | digital, scan+text | marker | 129 | 22923 | 27 | [1, 2, 3, 4] | 11 | 4 | 17 | 31.7 | 7.716 |
| 372605 | digital, scan+text | marker-strip | 129 | 22948 | 27 | [1, 2, 3] | 11 | 4 | 17 | 31.6 | 8.69 |
| 51059 | digital | marker | 206 | 34767 | 30 | [1, 2, 4] | 0 | 3 | 57 | 0.2 | 1.171 |
| 51059 | digital | marker-strip | 206 | 34767 | 30 | [1, 2, 4] | 0 | 3 | 57 | 0.2 | 1.188 |
| 5418 | image-only, scan+text | marker | 153 | 45470 | 20 | [1, 2, 3, 4] | 21 | 1 | 13 | 0.0 | 0.751 |
| 5418 | image-only, scan+text | marker-strip | 153 | 45470 | 20 | [1, 2, 3, 4] | 21 | 1 | 13 | 0.0 | 0.793 |
| 355302 | digital | marker | 431 | 56604 | 43 | [1, 2, 3, 4] | 87 | 9 | 75 | 20.0 | 3.791 |
| 355302 | digital | marker-strip | 431 | 56604 | 43 | [1, 2, 3, 4] | 87 | 9 | 75 | 20.0 | 3.806 |
| 46870 | digital, image-only | marker | 187 | 39924 | 26 | [1, 2, 3, 4] | 18 | 5 | 17 | 17.1 | 0.991 |
| 46870 | digital, image-only | marker-strip | 187 | 39924 | 26 | [1, 2, 3, 4] | 18 | 5 | 17 | 17.1 | 1.032 |
| 19582 | digital | marker | 403 | 88585 | 39 | [1, 2, 3, 4] | 18 | 5 | 50 | 20.0 | 0.886 |
| 19582 | digital | marker-strip | 403 | 88585 | 39 | [1, 2, 3, 4] | 18 | 5 | 50 | 20.0 | 0.885 |
| 75814 | image-only | marker | 267 | 47258 | 54 | [1, 2, 3] | 0 | 19 | 36 | 25.3 | 5.463 |
| 75814 | image-only | marker-strip | 267 | 47258 | 54 | [1, 2, 3] | 0 | 19 | 36 | 25.3 | 5.45 |
| 31196 | digital, scan+text | marker | 479 | 82674 | 86 | [1, 2, 3, 4] | 35 | 5 | 140 | 16.2 | 0.796 |
| 31196 | digital, scan+text | marker-strip | 479 | 82674 | 86 | [1, 2, 3, 4] | 35 | 5 | 140 | 16.2 | 1.239 |
| 19557 | digital | marker | 498 | 129309 | 101 | [1, 2, 3, 4] | 11 | 5 | 60 | 22.4 | 0.885 |
| 19557 | digital | marker-strip | 498 | 129309 | 101 | [1, 2, 3, 4] | 11 | 5 | 60 | 22.4 | 0.887 |
| 102474 | digital, image-only | marker | 1027 | 143441 | 151 | [1, 3, 4] | 113 | 54 | 238 | 18.3 | 16.772 |
| 102474 | digital, image-only | marker-strip | 1027 | 143441 | 151 | [1, 3, 4] | 113 | 54 | 238 | 18.3 | 16.787 |
| 8a1cc78e | scan+text, image-only, digital | marker | 739 | 181288 | 105 | [1, 2, 3, 4] | 27 | 37 | 117 | 21.3 | 13.891 |
| 8a1cc78e | scan+text, image-only, digital | marker-strip | 739 | 180901 | 105 | [1, 2, 3, 4] | 27 | 37 | 117 | 21.3 | 13.985 |
| e87e4ace | image-only | marker | 63 | 4745 | 12 | [1, 2, 4] | 18 | 0 | 5 | 17.6 | 18.242 |
| e87e4ace | image-only | marker-strip | 63 | 4745 | 12 | [1, 2, 4] | 18 | 0 | 5 | 17.6 | 18.238 |
| 504fb542 | digital | marker | 79 | 13611 | 17 | [1, 2, 3, 4] | 15 | 2 | 9 | 12.0 | 0.731 |
| 504fb542 | digital | marker-strip | 79 | 13611 | 17 | [1, 2, 3, 4] | 15 | 2 | 9 | 12.0 | 0.735 |
| e9bad2e8 | scan+text, image-only | marker | 568 | 119709 | 88 | [1, 2, 3, 4] | 73 | 23 | 68 | 0.0 | 8.634 |
| e9bad2e8 | scan+text, image-only | marker-strip | 562 | 119938 | 88 | [1, 2, 3, 4] | 73 | 23 | 68 | 0.0 | 14.085 |
| f4585a45 | digital | marker | 90 | 7937 | 15 | [1, 2, 3, 4] | 31 | 1 | 6 | 30.4 | 1.054 |
| f4585a45 | digital | marker-strip | 90 | 7937 | 15 | [1, 2, 3, 4] | 31 | 1 | 6 | 30.4 | 1.057 |
| 47b5d29b | digital | marker | 82 | 7908 | 14 | [1, 2, 4] | 26 | 1 | 6 | 29.4 | 1.006 |
| 47b5d29b | digital | marker-strip | 82 | 7908 | 14 | [1, 2, 4] | 26 | 1 | 6 | 29.4 | 1.01 |
| 63ec8679 | image-only | marker | 232 | 37623 | 90 | [1, 2, 3, 4] | 20 | 1 | 18 | 22.8 | 7.929 |
| 63ec8679 | image-only | marker-strip | 232 | 37623 | 90 | [1, 2, 3, 4] | 20 | 1 | 18 | 22.8 | 7.958 |
| b3ffd2a8 | scan+text, digital | marker | 739 | 133360 | 95 | [1, 2, 3] | 12 | 1 | 54 | 0.6 | 6.865 |
| b3ffd2a8 | scan+text, digital | marker-strip | 739 | 133410 | 95 | [1, 2, 3] | 12 | 1 | 54 | 0.6 | 7.353 |
| 71965693 | digital | marker | 369 | 52149 | 55 | [1, 2, 4] | 29 | 26 | 85 | 18.3 | 0.918 |
| 71965693 | digital | marker-strip | 369 | 51374 | 55 | [1, 2, 4] | 29 | 26 | 85 | 18.0 | 1.169 |
| c083beda | blank, digital | marker | 354 | 89830 | 57 | [1, 2, 3, 4] | 20 | 25 | 2 | 0.7 | 1.686 |
| c083beda | blank, digital | marker-strip | 354 | 89830 | 57 | [1, 2, 3, 4] | 20 | 25 | 2 | 0.7 | 1.672 |
| 34783e9d | digital | marker | 805 | 166971 | 97 | [1, 2, 3, 4] | 53 | 35 | 177 | 19.9 | 0.784 |
| 34783e9d | digital | marker-strip | 804 | 166709 | 97 | [1, 2, 4] | 53 | 35 | 177 | 19.9 | 6.742 |
| 40178058 | digital, blank | marker | 475 | 96342 | 80 | [1, 2, 3, 4] | 74 | 21 | 40 | 24.7 | 2.962 |
| 40178058 | digital, blank | marker-strip | 475 | 96342 | 80 | [1, 2, 3, 4] | 74 | 21 | 40 | 24.7 | 2.978 |
| 810ca2af | image-only, digital, blank | marker | 697 | 179886 | 55 | [1, 2, 3, 4] | 49 | 22 | 107 | 20.6 | 0.787 |
| 810ca2af | image-only, digital, blank | marker-strip | 697 | 179887 | 55 | [1, 2, 3, 4] | 49 | 22 | 107 | 20.6 | 0.83 |
| 7ca7961d | digital, scan+text, blank, image-only | marker | 550 | 74801 | 72 | [1, 2, 3, 4] | 91 | 11 | 60 | 16.0 | 1.141 |
| 7ca7961d | digital, scan+text, blank, image-only | marker-strip | 550 | 74634 | 72 | [1, 2, 4] | 91 | 11 | 60 | 16.0 | 4.446 |
| 36e2d1d0 | digital | marker | 273 | 30374 | 75 | [1, 2, 3, 4] | 17 | 4 | 16 | 14.2 | 2.61 |
| 36e2d1d0 | digital | marker-strip | 273 | 30340 | 75 | [1, 2, 3, 4] | 17 | 4 | 16 | 14.2 | 5.156 |
| 73e413c8 | digital, blank | marker | 187 | 31838 | 28 | [1, 2, 3, 4] | 32 | 7 | 23 | 16.0 | 0.976 |
| 73e413c8 | digital, blank | marker-strip | 187 | 31838 | 28 | [1, 2, 3, 4] | 32 | 7 | 23 | 16.0 | 0.968 |
| d6e0e88b | digital, blank | marker | 169 | 35150 | 21 | [1, 2, 3, 4] | 28 | 3 | 38 | 1.7 | 0.836 |
| d6e0e88b | digital, blank | marker-strip | 169 | 35293 | 21 | [1, 2, 4] | 28 | 3 | 38 | 1.7 | 7.839 |
| 5cb6ee7a | digital | marker | 232 | 60387 | 29 | [1, 3, 4] | 17 | 1 | 15 | 19.5 | 0.878 |
| 5cb6ee7a | digital | marker-strip | 232 | 60387 | 29 | [1, 3, 4] | 17 | 1 | 15 | 19.5 | 0.899 |
| d17a8877 | image-only, digital, scan+text, blank | marker | 967 | 163924 | 180 | [1, 3, 4] | 34 | 53 | 164 | 20.5 | 2.196 |
| d17a8877 | image-only, digital, scan+text, blank | marker-strip | 968 | 163924 | 180 | [1, 3, 4] | 34 | 53 | 164 | 20.5 | 2.369 |
| 93050f9c | image-only | marker | 330 | 73364 | 21 | [1, 2, 3, 4] | 7 | 34 | 35 | 16.5 | 13.278 |
| 93050f9c | image-only | marker-strip | 330 | 73364 | 21 | [1, 2, 3, 4] | 7 | 34 | 35 | 16.5 | 13.283 |
| d71c0286 | digital | marker | 38 | 15270 | 7 | [1, 2, 3, 4] | 5 | 8 | 0 | 0.0 | 1.109 |
| d71c0286 | digital | marker-strip | 38 | 15270 | 7 | [1, 2, 3, 4] | 5 | 8 | 0 | 0.0 | 1.14 |
| cc081a8d | digital, blank | marker | 179 | 35825 | 29 | [1, 2, 3, 4] | 27 | 6 | 21 | 20.5 | 3.193 |
| cc081a8d | digital, blank | marker-strip | 179 | 35825 | 29 | [1, 2, 3, 4] | 27 | 6 | 21 | 20.5 | 3.195 |
| 7c683b2a | digital, blank | marker | 468 | 96103 | 74 | [1, 2, 3, 4] | 45 | 4 | 40 | 30.2 | 1.008 |
| 7c683b2a | digital, blank | marker-strip | 468 | 96103 | 74 | [1, 2, 3, 4] | 45 | 4 | 40 | 30.2 | 1.016 |
| 7d136c1c | digital | marker | 153 | 26103 | 44 | [1, 2, 3, 4] | 6 | 1 | 12 | 17.2 | 1.593 |
| 7d136c1c | digital | marker-strip | 153 | 26103 | 44 | [1, 2, 3, 4] | 6 | 1 | 12 | 17.2 | 1.606 |
