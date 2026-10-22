"""Step 2: automated checks on every sampled pair, per page.

Each check gives two flags per page:
  plan   the evaluation plan's rule at its starting threshold (a disagreement in either direction)
  tuned  the same check counted only where KUDOS is the worse side, plus two threshold changes:
         repeated header/footer lines are stripped first, and similarity is word 5-gram overlap

Checks (plan rule / tuned rule):
  page alignment  KUDOS pages (split on \\f) vs the PDF's page count (PyMuPDF); doc level
  coverage        char ratio outside 0.9-1.1 (both >= 100 chars) or empty in one source /
                  < 90% of our words found in KUDOS, or KUDOS empty where ours is not
  similarity      normalized Levenshtein < 0.9 / word 5-gram F1 < 0.8 (both >= 20 words)
  noise           out-of-dictionary share (nb + nn Hunspell) >= 5 points and 1.5x the other
                  source, or mojibake in one source only / KUDOS the worse side
  numbers         number sets differ / a number in ours is missing from KUDOS
  language        top language (nb, nn, en; Lingua) differs, or confidence < 0.75 /
                  differs, or KUDOS low while ours is not
  unicode         U+FFFD, ligatures, private-use glyphs or decomposed (NFD) letters, either / KUDOS
  glued_spaced    glued words (>= 30 letters, unknown), letter-spaced runs (>= 3 single letters)
                  and split words (two fragments that form a known word), per 100 words;
                  >= 1 per 100 and 2x the other source / KUDOS the higher
  duplicated      a sentence (>= 40 chars) repeated within the page, either / KUDOS more than ours
  text layer      PyMuPDF: does the page have a native text layer (>= 50 chars); reported, not flagged

Our text is rebuilt from the Typesense chunks: chunks in chunk_index order, with the heading
lines the chunker stripped put back from each chunk's metadata, split on Marker's page markers.
"""
import collections
import csv
import html
import json
import multiprocessing as mp
import re
import sys
import unicodedata

import fitz
from lingua import Language, LanguageDetectorBuilder
from rapidfuzz.distance import Levenshtein

from common import CHECKS, DATA, RESULTS, SAMPLE

SHINGLE_MIN = 0.8
LANG_MIN = 0.75

# --- our text ---------------------------------------------------------------------------

HEADER = re.compile(r'"Header (\d)" "((?:[^"\\]|\\.)*)"')
PAGE_MARK = re.compile(r"\{(\d+)\}\s*\n-{48}(?:\n|$)")
ANCHOR_PAGE = re.compile(r'id="page-(\d+)-\d+"')


def headers(meta):
    return {int(l): re.sub(r"\\(.)", r"\1", t) for l, t in HEADER.findall(meta or "")}


def rebuild_pages(rows):
    """Pages of our text from its chunks, keyed by Marker's 0-based page index, plus the indexes
    that had a page marker.

    A heading the chunker stripped goes back at the start of its chunk, or onto the page its
    Marker anchor names when that differs (merged chunks carry a later section's headings).
    Each heading goes back once.
    """
    pages, marked = collections.defaultdict(str), set()
    seen, placed, prev, page = set(), set(), {}, 0
    for r in rows:
        if r["chunk_index"] in seen:
            continue
        seen.add(r["chunk_index"])
        cur = headers(r.get("metadata"))
        changed = [l for l in sorted(cur) if prev.get(l) != cur[l]]
        lead = []
        for l in sorted(cur) if changed else []:
            if l < changed[0] or (l, cur[l]) in placed:
                continue
            placed.add((l, cur[l]))
            line = "#" * l + " " + cur[l]
            anchor = ANCHOR_PAGE.search(cur[l])
            if anchor and int(anchor.group(1)) != page:
                pages[int(anchor.group(1))] += "\n\n" + line + "\n\n"
            else:
                lead.append(line)
        prev = cur
        text = "\n\n".join(lead + [r["content_markdown"]])
        pos = 0
        for m in PAGE_MARK.finditer(text):
            pages[page] += text[pos : m.start()]
            page, pos = int(m.group(1)), m.end()
            marked.add(page)
        pages[page] += text[pos:] + "\n\n"
    return dict(pages), marked


def ours_pages(doc_num):
    rows = [json.loads(l) for l in open(DATA / "ours" / f"{doc_num}.jsonl")]
    pages, marked = rebuild_pages(rows)
    return pages, len(rows), marked


# --- normalization ----------------------------------------------------------------------

TAG = re.compile(r"<[^>]+>")
IMG = re.compile(r"!\[[^\]]*\]\([^)]*\)")
LINK = re.compile(r"\[([^\]]*)\]\([^)]*\)")
TABLE_SEP = re.compile(r"^\s*\|?[\s:|-]*-{3,}[\s:|-]*$", re.M)
HEAD = re.compile(r"^\s*#{1,6}\s+", re.M)
BULLET = re.compile(r"^\s*(?:[-*+•▪●◦·\uf0b7\uf0a7\uf0d8\uf0fc]|\d+[.)])\s+", re.M)
EMPH = re.compile(r"\*\*|__|(?<![\w])[*_]|[*_](?![\w])")


def markdown_to_text(t):
    """Our Markdown as plain lines: markup gone, line breaks kept."""
    t = IMG.sub(" ", t)
    t = LINK.sub(r"\1", t)
    t = TAG.sub(" ", html.unescape(t))
    t = TABLE_SEP.sub(" ", t)
    t = HEAD.sub("", t)
    t = BULLET.sub("", t)
    return EMPH.sub("", t.replace("|", " ")).replace("\\", "")


def norm_ours(t):
    return " ".join(markdown_to_text(t).split())


def norm_kudos(t):
    return " ".join(BULLET.sub("", t).split())


def nonspace(t):
    return len(t) - t.count(" ")


# --- words, dictionary ------------------------------------------------------------------

WORD = re.compile(r"[^\W\d_]+(?:-[^\W\d_]+)*")
TOKEN = re.compile(r"[^\W\d_]+")
MOJIBAKE = re.compile(r"Ã[\u0080-\u00bf˜…†]|Â[\u00a0-\u00bf]|â€|\ufffd")
BROKEN_HYPHEN = re.compile(r"[a-zæøå]{2,}-[ \t]*\n\s*(?!og\b|eller\b|samt\b|til\b|enn\b)[a-zæøå]{2,}")
TOC_LINE = re.compile(r"(?:\.{4,}|…{2,}|\. \. \.)\s*\d+\s*$", re.M)


def words(t):
    return [w for w in WORD.findall(t) if len(w) >= 2]


_dicts = None


def _init():
    global _dicts
    from spylls.hunspell import Dictionary
    _dicts = [Dictionary.from_files(str(DATA / "dict" / n)) for n in ("nb_NO", "nn_NO")]


def _known(w):
    def one(x):
        return any(d.lookup(x) for d in _dicts)
    if one(w):
        return w, True
    parts = w.split("-")
    return w, len(parts) > 1 and all(len(p) < 2 or one(p) for p in parts)


def build_lexicon(tokens):
    with mp.Pool(8, initializer=_init) as pool:
        return dict(pool.imap_unordered(_known, sorted(tokens), chunksize=500))


def split_candidates(tokens, lex):
    """Adjacent fragment pairs, at least one unknown, whose join might be a known word."""
    return {a + b for a, b in zip(tokens, tokens[1:])
            if len(a) >= 2 and len(b) >= 2 and not (lex.get(a) and lex.get(b))}


# --- per-source page measures -----------------------------------------------------------

NUM = re.compile(r"\d+(?:[.,]\d+)*(?: ?%)?")
THOUSANDS = re.compile(r"(?<=\d) (?=\d{3}(?!\d))")
THIN_SPACES = re.compile(r"[\u00a0\u202f\u2009\u2007]")
PAGE_NO = re.compile(r"^\s*(?:side\s*)?(\d{1,4})(?:\s*(?:/|av)\s*\d{1,4})?\s*$", re.I)
LIGATURE = re.compile(r"[\ufb00-\ufb06]")
PUA = re.compile(r"[\ue000-\uf8ff]")


def edge_indexes(lines):
    body = [i for i, l in enumerate(lines) if l.strip()]
    return set(body[:4] + body[-4:])


def page_number_offset(pages_lines):
    """Printed page number minus page index, when a lone number at the page edge follows the
    page sequence on >= 30% of pages (min 3). None when the source carries no page numbers."""
    offsets = collections.Counter()
    for i, lines in enumerate(pages_lines):
        for j in edge_indexes(lines):
            m = PAGE_NO.match(lines[j])
            if m:
                offsets[int(m.group(1)) - (i + 1)] += 1
    if not offsets:
        return None
    off, n = offsets.most_common(1)[0]
    return off if n >= max(3, 0.3 * len(pages_lines)) else None


def numbers(lines, page_number):
    """Amounts, years and percentages: >= 3 digits, a decimal part or a % sign.

    The printed page number is dropped from the page edge; thousands separators are joined.
    """
    edge = edge_indexes(lines)
    kept = [l for j, l in enumerate(lines)
            if not (j in edge and page_number is not None and (m := PAGE_NO.match(l)) and int(m.group(1)) == page_number)]
    t = THOUSANDS.sub("", THIN_SPACES.sub(" ", "\n".join(kept)))
    out = set()
    for n in NUM.findall(t):
        n = n.rstrip(".,").replace(" ", "")
        if n.endswith("%") or len(re.sub(r"\D", "", n)) >= 3 or re.search(r"[.,]\d", n):
            out.add(n)
    return out


def unicode_issues(raw):
    return {
        "fffd": raw.count("\ufffd"),
        "ligature": len(LIGATURE.findall(raw)),
        "pua": len(PUA.findall(raw)),
        "nfd": len(raw) - len(unicodedata.normalize("NFC", raw)),
    }


def glued_spaced(text, lex):
    toks = TOKEN.findall(text)
    if not toks:
        return 0, 0, 0, 0
    glued = sum(1 for w in toks if len(w) >= 30 and not lex.get(w))
    spaced, run = 0, 0
    for w in toks + [""]:
        if len(w) == 1:
            run += 1
        else:
            spaced += run >= 3
            run = 0
    split = sum(1 for a, b in zip(toks, toks[1:])
                if len(a) >= 2 and len(b) >= 2 and not (lex.get(a) and lex.get(b)) and lex.get(a + b))
    return glued, spaced, split, len(toks)


LEADERS = re.compile(r"(?:\.\s?){3,}|…+")
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


def duplicates(lines):
    """Sentences (>= 40 chars) repeated within the page. Sentences, not lines, so both sources
    compare alike; dotted table-of-contents leaders removed first."""
    text = " ".join(LEADERS.sub(" ", " ".join(lines)).split())
    sentences = [s for s in SENTENCE_END.split(text) if len(s) >= 40]
    return len(sentences) - len(set(sentences))


DETECTOR = LanguageDetectorBuilder.from_languages(Language.BOKMAL, Language.NYNORSK, Language.ENGLISH).build()


def languages(texts):
    """(language, confidence) per text with >= 20 words, else (None, None)."""
    out = []
    for t in texts:
        if len(words(t)) < 20:
            out.append((None, None))
            continue
        top = DETECTOR.compute_language_confidence_values(t)[0]
        out.append(({"BOKMAL": "nb", "NYNORSK": "nn", "ENGLISH": "en"}[top.language.name], top.value))
    return out


# --- PDF --------------------------------------------------------------------------------

def pdf_pages(path):
    out = []
    with fitz.open(path) as doc:
        for page in doc:
            area = page.rect.width * page.rect.height or 1
            chars = len(re.sub(r"\s", "", page.get_text("text")))
            cover = 0.0
            for info in page.get_image_info():
                r = fitz.Rect(info["bbox"]) & page.rect
                cover += r.width * r.height if not r.is_empty else 0
            cover = min(cover / area, 1.0)
            w = page.rect.width
            blocks = [b for b in page.get_text("blocks") if b[6] == 0 and len(b[4].strip()) >= 80]
            left = sum(1 for b in blocks if b[2] <= 0.55 * w)
            right = sum(1 for b in blocks if b[0] >= 0.45 * w)
            if cover >= 0.85:
                kind = "scan+text" if chars >= 50 else "image-only"
            else:
                kind = "digital" if chars >= 50 else "blank"
            out.append({"kind": kind, "text_layer": chars >= 50, "text_layer_chars": chars,
                        "image_cover": round(cover, 2), "multi_column": left >= 2 and right >= 2})
    return out


def doc_class(pdf):
    scan = sum(p["kind"] in ("scan+text", "image-only") for p in pdf) / max(len(pdf), 1)
    return "scanned" if scan >= 0.5 else "mixed" if scan >= 0.1 else "born-digital"


# --- repeated header/footer lines -------------------------------------------------------

def line_key(line):
    return re.sub(r"\d+", "#", line.strip().lower())


def boilerplate_key(key):
    """A line that can be boilerplate: >= 3 letters, or >= 2 numbers ("2025–2026"), never a lone number."""
    return len(re.sub(r"[#\W\d_]", "", key)) >= 3 or key.count("#") >= 2


def boilerplate(pages):
    """Lines among the first/last four of a page that repeat on >= 30% of pages (min 3).

    Returns the share of pages carrying one and the set of repeated line keys.
    """
    edge = []
    for t in pages:
        lines = t.split("\n")
        edge.append({k for k in (line_key(lines[j]) for j in edge_indexes(lines)) if boilerplate_key(k)})
    count = collections.Counter(k for e in edge for k in e)
    floor = max(3, 0.3 * len(pages))
    rep = {k for k, c in count.items() if c >= floor}
    return sum(1 for e in edge if e & rep) / max(len(pages), 1), rep


def strip_lines(t, rep):
    """Drop repeated header/footer lines, at the page edges only."""
    lines = t.split("\n")
    edge = edge_indexes(lines)
    return "\n".join(l for j, l in enumerate(lines) if not (j in edge and line_key(l) in rep))


def shingle_f1(a, b, n=5):
    """Overlap of word n-grams: robust to moved blocks, low for interleaved lines or garbled text."""
    def grams(ws):
        ws = [w.lower() for w in ws]
        return collections.Counter(tuple(ws[i : i + n]) for i in range(len(ws) - n + 1))
    ga, gb = grams(a), grams(b)
    if not ga and not gb:
        return None
    return 2 * sum((ga & gb).values()) / (sum(ga.values()) + sum(gb.values()))


def worse(k, o, clearly):
    """'kudos', 'ours', 'both' or '' for two per-source measures, given a 'clearly higher' test."""
    if clearly(k, o):
        return "kudos"
    if clearly(o, k):
        return "ours"
    return ""


# --- main -------------------------------------------------------------------------------

def lookup(lex, tokens, cache):
    missing = tokens - lex.keys()
    print(f"{len(tokens)} distinct words, {len(missing)} to look up", file=sys.stderr)
    if missing:
        lex.update(build_lexicon(missing))
        cache.write_text(json.dumps(lex, ensure_ascii=False))


def r3(x):
    return round(x, 3) if x is not None else ""


def main():
    RESULTS.mkdir(parents=True, exist_ok=True)
    sample = json.loads(SAMPLE.read_text())

    docs = []
    for s in sample:
        kt = (DATA / "kudos" / f'{s["uuid"]}.txt').read_text()
        op, n_chunks, marked = ours_pages(s["doc_num"])
        pdf = pdf_pages(DATA / "pdf" / f'{s["doc_num"]}.pdf')
        docs.append((s, kt, kt.split("\f"), op, n_chunks, marked, pdf))
    print(f"loaded {len(docs)} docs", file=sys.stderr)

    cache = DATA / "lexicon.json"
    lex = json.loads(cache.read_text()) if cache.exists() else {}
    texts = [t for _, kt, _, op, _, _, _ in docs for t in (kt, markdown_to_text("\n".join(op.values())))]
    lookup(lex, {w for t in texts for w in words(t)} | {w for t in texts for w in TOKEN.findall(t) if len(w) >= 30},
           cache)
    lookup(lex, {c for t in texts for c in split_candidates(TOKEN.findall(t), lex)}, cache)

    def oov(ws):
        return sum(1 for w in ws if not lex.get(w, False)) / len(ws) if ws else None

    page_rows, doc_rows = [], []
    for s, kt, kp, op, n_chunks, marked, pdf in docs:
        n_pdf = len(pdf)
        o_marks = sorted(marked)
        flags_doc = collections.Counter()
        table_pages = 0
        o_list = [op.get(i, "") for i in range(n_pdf)]
        bp_k, rep_k = boilerplate(kp)
        bp_o, rep_o = boilerplate(o_list)
        k_clean_pages = [strip_lines(kp[i] if i < len(kp) else "", rep_k) for i in range(n_pdf)]
        o_clean_pages = [markdown_to_text(strip_lines(o_list[i], rep_o)) for i in range(n_pdf)]
        lang_k = languages(k_clean_pages)
        lang_o = languages(o_clean_pages)
        off_k = page_number_offset([t.split("\n") for t in k_clean_pages])
        off_o = page_number_offset([t.split("\n") for t in o_clean_pages])
        for i in range(n_pdf):
            kraw = kp[i] if i < len(kp) else ""
            oraw = o_list[i]
            k, o = norm_kudos(kraw), norm_ours(oraw)
            ck, co = nonspace(k), nonspace(o)
            ratio = ck / co if co else None
            sim = Levenshtein.normalized_similarity(k, o) if max(ck, co) else 1.0
            wk, wo = words(kraw), words(norm_ours(oraw))
            ok_, oo = oov(wk), oov(wo)
            mk, mo = len(MOJIBAKE.findall(kraw)), len(MOJIBAKE.findall(oraw))
            is_table = sum(1 for l in oraw.split("\n") if l.lstrip().startswith("|")) >= 3
            table_pages += is_table

            kc_lines, oc_lines = k_clean_pages[i].split("\n"), o_clean_pages[i].split("\n")
            kc, oc = norm_kudos(k_clean_pages[i]), " ".join(o_clean_pages[i].split())
            cck, cco = nonspace(kc), nonspace(oc)
            ratio_clean = cck / cco if cco else None
            wkc, woc = words(kc), words(oc)
            sh = shingle_f1(wkc, woc)
            bkc, boc = collections.Counter(w.lower() for w in wkc), collections.Counter(w.lower() for w in woc)
            common = sum((bkc & boc).values())
            ours_in_kudos = common / len(woc) if woc else None
            kudos_in_ours = common / len(wkc) if wkc else None

            nk = numbers(kc_lines, None if off_k is None else i + 1 + off_k)
            no = numbers(oc_lines, None if off_o is None else i + 1 + off_o)
            (lk, lck), (lo, lco) = lang_k[i], lang_o[i]
            uk, uo = unicode_issues(kraw), unicode_issues(oraw)
            gk, go = glued_spaced(k_clean_pages[i], lex), glued_spaced(o_clean_pages[i], lex)
            rate_k = 100 * sum(gk[:3]) / gk[3] if gk[3] >= 20 else None
            rate_o = 100 * sum(go[:3]) / go[3] if go[3] >= 20 else None
            dk, do = duplicates(kc_lines), duplicates(oc_lines)

            plan, tuned = [], []

            # coverage
            if (ck < 10) != (co < 10) or (min(ck, co) >= 100 and not 0.9 <= ratio <= 1.1):
                plan.append("coverage")
            if (cck < 10 <= cco) or (len(woc) >= 20 and ours_in_kudos < 0.9):
                tuned.append("coverage")
            # similarity
            if max(ck, co) >= 20 and sim < 0.9:
                plan.append("similarity")
            if min(len(wkc), len(woc)) >= 20 and sh < SHINGLE_MIN:
                tuned.append("similarity")
            # noise
            noise_side = ""
            if ok_ is not None and oo is not None and len(wk) >= 20 and len(wo) >= 20:
                noise_side = worse(ok_, oo, lambda a, b: a - b >= 0.05 and a >= 1.5 * b)
            if (mk > 0) != (mo > 0):
                noise_side = noise_side or ("kudos" if mk else "ours")
            if noise_side:
                plan.append("noise")
            if noise_side == "kudos":
                tuned.append("noise")
            # numbers
            if nk != no:
                plan.append("numbers")
            if no - nk:
                tuned.append("numbers")
            # language
            low_k = lck is not None and lck < LANG_MIN
            low_o = lco is not None and lco < LANG_MIN
            differ = lk is not None and lo is not None and lk != lo
            if differ or low_k or low_o:
                plan.append("language")
            if differ or (low_k and not low_o):
                tuned.append("language")
            # unicode
            if sum(uk.values()) or sum(uo.values()):
                plan.append("unicode")
            if sum(uk.values()):
                tuned.append("unicode")
            # glued / spaced words
            gs_side = ""
            if rate_k is not None and rate_o is not None:
                gs_side = worse(rate_k, rate_o, lambda a, b: a >= 1 and a >= 2 * b)
            if gs_side:
                plan.append("glued_spaced")
            if gs_side == "kudos":
                tuned.append("glued_spaced")
            # duplicated text
            if dk or do:
                plan.append("duplicated")
            if dk > do:
                tuned.append("duplicated")

            for f in plan:
                flags_doc[f] += 1
            for f in tuned:
                flags_doc["tuned_" + f] += 1

            hints = []
            if i not in marked:
                hints.append("ours_page_missing")
            if (cco < 10 <= cck) or (len(wkc) >= 20 and kudos_in_ours < 0.9):
                hints.append("kudos_extra")
            if len(TOC_LINE.findall(kraw)) >= 3:
                hints.append("toc_like")
            if is_table:
                hints.append("table")
            if pdf[i]["multi_column"]:
                hints.append("multi_column")
            if not pdf[i]["text_layer"]:
                hints.append("no_text_layer")
            page_rows.append({
                "doc_num": s["doc_num"], "uuid": s["uuid"], "type": s["type"], "page": i + 1,
                "pdf_kind": pdf[i]["kind"], "text_layer": pdf[i]["text_layer"],
                "text_layer_chars": pdf[i]["text_layer_chars"], "chars_kudos": ck, "chars_ours": co,
                "coverage_ratio": r3(ratio), "coverage_ratio_clean": r3(ratio_clean),
                "ours_words_in_kudos": r3(ours_in_kudos), "kudos_words_in_ours": r3(kudos_in_ours),
                "similarity": round(sim, 3), "shingle_f1": r3(sh),
                "oov_kudos": r3(ok_), "oov_ours": r3(oo), "mojibake_kudos": mk, "mojibake_ours": mo,
                "broken_hyphen_kudos": len(BROKEN_HYPHEN.findall(kraw)),
                "broken_hyphen_ours": len(BROKEN_HYPHEN.findall(oraw)), "noise_worse": noise_side,
                "numbers_kudos": len(nk), "numbers_ours": len(no),
                "numbers_missing_in_kudos": " ".join(sorted(no - nk)[:8]),
                "numbers_missing_in_ours": " ".join(sorted(nk - no)[:8]),
                "lang_kudos": lk or "", "lang_conf_kudos": r3(lck),
                "lang_ours": lo or "", "lang_conf_ours": r3(lco),
                **{f"{key}_kudos": uk[key] for key in uk}, **{f"{key}_ours": uo[key] for key in uo},
                "glued_kudos": gk[0], "spaced_runs_kudos": gk[1], "split_words_kudos": gk[2],
                "glued_ours": go[0], "spaced_runs_ours": go[1], "split_words_ours": go[2],
                "glued_spaced_per100_kudos": r3(rate_k), "glued_spaced_per100_ours": r3(rate_o),
                "duplicates_kudos": dk, "duplicates_ours": do,
                "flags": " ".join(plan), "flags_tuned": " ".join(tuned), "hints": " ".join(hints),
            })

        k_align = len(kp) == n_pdf
        o_align = len(o_marks) == n_pdf and (max(o_marks) + 1 if o_marks else 0) == n_pdf
        mine = page_rows[-n_pdf:] if n_pdf else []
        flagged_plan = sum(1 for r in mine if r["flags"])
        flagged_tuned = sum(1 for r in mine if r["flags_tuned"])
        doc_rows.append({
            "doc_num": s["doc_num"], "uuid": s["uuid"], "type": s["type"], "stratum": s["stratum"],
            "weight": round(s["weight"], 3), "publish_year": s["publish_year"], "pdf_pages": n_pdf,
            "pages_meta": s["pages_meta"], "kudos_pages": len(kp), "ours_pages": len(o_marks),
            "ours_chunks": n_chunks, "kudos_page_aligned": k_align, "ours_page_aligned": o_align,
            "pdf_class": doc_class(pdf), "no_text_layer_pages": sum(not p["text_layer"] for p in pdf),
            "multi_column_pages": sum(p["multi_column"] for p in pdf), "table_pages": table_pages,
            "kudos_chars": nonspace(norm_kudos(kt)), "ours_chars": nonspace(norm_ours("\n".join(op.values()))),
            "boilerplate_kudos": round(bp_k, 3), "boilerplate_ours": round(bp_o, 3),
            **{f"plan_{f}": flags_doc[f] for f in CHECKS},
            **{f"tuned_{f}": flags_doc["tuned_" + f] for f in CHECKS},
            "flagged_pages": flagged_plan, "flagged_pages_tuned": flagged_tuned,
            "verdict": "identical in practice" if k_align and not flagged_plan else "inspect by hand",
            "verdict_tuned": "identical in practice" if k_align and not flagged_tuned else "inspect by hand",
        })

    for name, rows in (("pages.csv", page_rows), ("docs.csv", doc_rows)):
        with open(RESULTS / name, "w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0]))
            w.writeheader()
            w.writerows(rows)
    print(f"wrote {len(doc_rows)} docs, {len(page_rows)} pages to {RESULTS}", file=sys.stderr)


if __name__ == "__main__":
    main()
