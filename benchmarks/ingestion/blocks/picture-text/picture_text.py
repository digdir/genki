import json, sys, random, glob, collections
root = sys.argv[1]
files = sorted(glob.glob(root + '/docling/*/*/docling.json'))
seed = int(sys.argv[2]) if len(sys.argv) > 2 else 7
random.seed(seed); files = random.sample(files, 300)
FURN = {'page_header','page_footer'}
tot=body_empty=pic_only=pic_only_big=0
for f in files:
    d = json.load(open(f))
    texts = {t['self_ref']: t for t in d['texts']}
    pics = {p['self_ref'] for p in d['pictures']}
    def under_pic(t):
        p = t.get('parent', {}).get('$ref')
        seen=0
        while p and seen<20:
            if p in pics: return True
            p = (texts.get(p) or {}).get('parent', {}).get('$ref'); seen+=1
        return False
    body = collections.Counter(); pic = collections.Counter()
    for t in d['texts']:
        if t.get('content_layer','body')!='body' or t['label'] in FURN: continue
        s = (t.get('text') or '').strip()
        if not s or not t.get('prov'): continue
        pg = t['prov'][0]['page_no']
        (pic if under_pic(t) else body)[pg] += len(s)
    for tb in d['tables']:
        if tb.get('prov'): body[tb['prov'][0]['page_no']] += 1
    for pg in d['pages']:
        pg=int(pg); tot+=1
        if body[pg] < 20:
            body_empty+=1
            if pic[pg] > 0: pic_only+=1
            if pic[pg] >= 200: pic_only_big+=1
print(f"seed {seed} files 300 pages {tot} no-body-text {body_empty} of-which-text-in-pictures {pic_only} (>=200 chars: {pic_only_big})")
