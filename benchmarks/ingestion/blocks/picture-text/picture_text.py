"""Count pages of the Docling export whose only text is inside pictures.

python3 -I picture_text.py <export root> [seed]
Reads 300 random docling.json files under <export root>/docling/*/*/.
"""
import collections
import glob
import json
import random
import sys

root = sys.argv[1]
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
files = sorted(glob.glob(root + '/docling/*/*/docling.json'))
random.seed(seed)
files = random.sample(files, 300)
FURNITURE = {'page_header', 'page_footer'}
pages = no_body = picture_only = picture_only_200 = 0
for f in files:
    d = json.load(open(f))
    items = {}
    for kind in ('texts', 'groups', 'tables', 'pictures'):
        for item in d.get(kind, []):
            items[item['self_ref']] = item
    pictures = {p['self_ref'] for p in d['pictures']}

    def under_picture(item):
        ref = item.get('parent', {}).get('$ref')
        for _ in range(50):
            if not ref:
                return False
            if ref in pictures:
                return True
            ref = (items.get(ref) or {}).get('parent', {}).get('$ref')
        return False

    body = collections.Counter()
    picture = collections.Counter()
    for t in d['texts']:
        if t.get('content_layer', 'body') != 'body' or t['label'] in FURNITURE:
            continue
        text = (t.get('text') or '').strip()
        if not text or not t.get('prov'):
            continue
        page = t['prov'][0]['page_no']
        (picture if under_picture(t) else body)[page] += len(text)
    for table in d['tables']:
        if not table.get('prov') or under_picture(table):
            continue
        cells = sum(len((c.get('text') or '').strip()) for c in table.get('data', {}).get('table_cells', []))
        body[table['prov'][0]['page_no']] += cells
    for page in d['pages']:
        page = int(page)
        pages += 1
        if body[page] < 20:
            no_body += 1
            if picture[page] > 0:
                picture_only += 1
            if picture[page] >= 200:
                picture_only_200 += 1
print(f"seed {seed} pages {pages} no-body-text {no_body} text-only-in-pictures {picture_only} (>=200 chars: {picture_only_200})")
