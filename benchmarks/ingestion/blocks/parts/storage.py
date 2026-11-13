"""Space and read and write times of conversion parts in PostgreSQL 17, stored two ways (ADR 0055).

    docker run -d --name parts-measure -e POSTGRES_PASSWORD=x -p <port>:5432 postgres:17
    PARTS_DSN='host=127.0.0.1 port=<port> user=postgres password=x dbname=postgres' \
        <python with psycopg 3> -I storage.py <export root> [files] [seed]      # defaults: 300 files, seed 7
    docker rm -f parts-measure

Use a throwaway database: the script drops and creates the tables conv, pages_a, pages_b and parts_b.

The export root holds `<2 hex>/<sha256>/docling.json` (DoclingDocument JSON). Parts are made by `docling_blocks` and
`finish` in `../normalise.py`, kept in memory, and loaded two ways:

A  pages_a: one row per page, the page's parts as one jsonb array, with the page's first and last seq
B  pages_b: one row per page, and parts_b: one row per part

`variants` loads A and B alone, each with the default pglz and with lz4 compression, and gives the space
(heap, TOAST, index, total, bytes a page, GB scaled to 2.55 and 3.14 million pages) and the read times of
one page (a), the parts with seq within 5 of a part (b) and the pages either side of a page (c).
`usecases` loads A and B side by side (pglz) and times all body parts of a file (d, also on the file with
the most parts), the part holding a quote's offset (e), a file's tables (f), counting parts by kind and layer
over the whole sample (g), reading every table (h), and deleting and writing the file with the most parts (i).
Times are in ms: median, 95th percentile and rows a call, warm cache, 200 calls with random arguments.

Prints one JSON object and no document text; writes nothing to disk but the database.
"""
import json
import os
import random
import statistics
import sys
import time
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from normalise import docling_blocks, finish  # noqa: E402

DDL_CONV = "create table conv (id bigserial primary key, sha256 text not null);"
DDL_PAGES_A = """create table pages_a (conversion bigint not null, page int not null, label text, width real, height real,
  text_start int, text_end int, seq_from int not null, seq_to int not null, parts jsonb not null, primary key (conversion, page));"""
DDL_B = """create table pages_b (conversion bigint, page int, label text, width real, height real, text_start int, text_end int, primary key (conversion, page));
create table parts_b (conversion bigint not null, seq int not null, page int not null, kind text not null, layer text not null,
  level smallint, heading_path text[], text text not null, html text, start_at int, end_at int, regions jsonb not null, native text,
  primary key (conversion, seq));"""
DDL_A = "drop table if exists pages_a, conv; " + DDL_CONV + DDL_PAGES_A
DDL_ONLY_B = "drop table if exists pages_b, parts_b, conv; " + DDL_CONV + DDL_B
DDL_BOTH = "drop table if exists conv, pages_a, pages_b, parts_b; " + DDL_CONV + DDL_PAGES_A + DDL_B

READS = {
    ("A", "a"): "select parts from pages_a where conversion=%(c)s and page=%(p)s",
    ("A", "b"): """select e from pages_a, jsonb_array_elements(parts) e where conversion=%(c)s and seq_from <= %(k)s+5 and seq_to >= %(k)s-5
   and (e->>'seq')::int between %(k)s-5 and %(k)s+5 order by (e->>'seq')::int""",
    ("A", "c"): "select page, parts from pages_a where conversion=%(c)s and page between %(p)s-1 and %(p)s+1 order by page",
    ("B", "a"): "select * from parts_b where conversion=%(c)s and page=%(p)s order by seq",
    ("B", "b"): "select * from parts_b where conversion=%(c)s and seq between %(k)s-5 and %(k)s+5 order by seq",
    ("B", "c"): "select * from parts_b where conversion=%(c)s and page between %(p)s-1 and %(p)s+1 order by seq",
}
USES = {
    "d_A": "select e from pages_a, jsonb_array_elements(parts) e where conversion=%(c)s and e->>'layer'='body' order by (e->>'seq')::int",
    "d_B": "select * from parts_b where conversion=%(c)s and layer='body' order by seq",
    "e_A": """select page, e from pages_a, jsonb_array_elements(parts) e where conversion=%(c)s and text_start <= %(x)s and text_end > %(x)s
   and (e->>'start')::int <= %(x)s and (e->>'end')::int > %(x)s""",
    "e_B": """select * from (select * from parts_b where conversion=%(c)s and start_at <= %(x)s order by start_at desc limit 1) s where end_at > %(x)s""",
    "f_A": "select page, e from pages_a, jsonb_array_elements(parts) e where conversion=%(c)s and e->>'kind'='table' order by (e->>'seq')::int",
    "f_B": "select * from parts_b where conversion=%(c)s and kind='table' order by seq",
    "g_A": "select e->>'kind', e->>'layer', count(*) from pages_a, jsonb_array_elements(parts) e group by 1, 2",
    "g_B": "select kind, layer, count(*) from parts_b group by 1, 2",
    "h_A": "select conversion, page, e->>'seq', e->>'text', e->>'html' from pages_a, jsonb_array_elements(parts) e where e->>'kind'='table'",
    "h_B": "select conversion, page, seq, text, html from parts_b where kind='table'",
}


def prepare(root, count, seed):
    random.seed(seed)
    files = random.sample(sorted(Path(root).glob("*/*/docling.json")), count)
    docs, raw_bytes, noncontig = [], 0, 0
    for f in files:
        raw_bytes += f.stat().st_size
        d = json.loads(f.read_text())
        rb, sizes = docling_blocks(d)
        blocks, _, pages = finish(rb, sizes, "x", "docling")

        def label(ref):
            _, c, i = ref.split("/")
            return d[c][int(i)].get("label") or "unknown"

        parts, last = [], 1
        for b in blocks:
            p = b["page"] or last
            last = p
            parts.append({"seq": b["seq"], "page": p, "kind": label(b["native"]),
                          "layer": "furniture" if b["furniture"] else "body", "level": b["level"],
                          "heading_path": b["heading_path"], "text": b["text"] or "", "html": b["html"],
                          "start": b["start"], "end": b["end"],
                          "regions": [{"page": p, "bbox": b["bbox"], "start": b["start"], "end": b["end"]}],
                          "native": b["native"]})
        pg = []
        for pr in pages:
            seqs = [x["seq"] for x in parts if x["page"] == pr["page"]]
            if seqs and max(seqs) - min(seqs) + 1 != len(seqs):
                noncontig += 1
            pg.append({"page": pr["page"], "width": pr["width_pt"], "height": pr["height_pt"],
                       "text_start": pr["start"], "text_end": pr["end"]})
        docs.append({"sha": f.parent.name, "parts": parts, "pages": pg})
    return docs, raw_bytes, noncontig


def pobj(p):
    return {k: p[k] for k in ("seq", "kind", "layer", "level", "heading_path", "text", "html", "start", "end", "regions", "native")}


def rows_a(cid, d):
    by = {}
    for p in d["parts"]:
        by.setdefault(p["page"], []).append(p)
    nxt = 0
    for pg in d["pages"]:
        ps = by.get(pg["page"], [])
        sf, st = (min(x["seq"] for x in ps), max(x["seq"] for x in ps)) if ps else (nxt, nxt - 1)
        if ps:
            nxt = st + 1
        yield (cid, pg["page"], None, pg["width"], pg["height"], pg["text_start"], pg["text_end"], sf, st,
               json.dumps([pobj(x) for x in ps], ensure_ascii=False))


def write_a(cur, i, d):
    with cur.copy("copy pages_a from stdin") as cp:
        for r in rows_a(i, d):
            cp.write_row(r)


def write_b(cur, i, d):
    with cur.copy("copy pages_b from stdin") as cp:
        for pg in d["pages"]:
            cp.write_row((i, pg["page"], None, pg["width"], pg["height"], pg["text_start"], pg["text_end"]))
    with cur.copy("copy parts_b from stdin") as cp:
        for p in d["parts"]:
            cp.write_row((i, p["seq"], p["page"], p["kind"], p["layer"], p["level"], p["heading_path"], p["text"],
                          p["html"], p["start"], p["end"], json.dumps(p["regions"]), p["native"]))


def size(conn, t):
    return conn.execute(f"select pg_relation_size('{t}'), pg_total_relation_size('{t}')-pg_relation_size('{t}')-pg_indexes_size('{t}'),"
                        f" pg_indexes_size('{t}'), pg_total_relation_size('{t}')").fetchone()


def load(conn, docs, schema, lz4):
    conn.execute(DDL_A if schema == "A" else DDL_ONLY_B)
    if lz4:
        conn.execute("alter table pages_a alter column parts set compression lz4" if schema == "A" else
                     "alter table parts_b alter column text set compression lz4, alter column html set compression lz4,"
                     " alter column regions set compression lz4")
    t0 = time.time()
    with conn.cursor() as cur:
        for i, d in enumerate(docs, 1):
            cur.execute("insert into conv (id, sha256) values (%s,%s)", (i, d["sha"]))
            (write_a if schema == "A" else write_b)(cur, i, d)
    load_s = time.time() - t0
    conn.execute("vacuum analyze")
    tabs = ["pages_a"] if schema == "A" else ["pages_b", "parts_b"]
    s = [sum(size(conn, t)[k] for t in tabs) for k in range(4)]
    return load_s, dict(zip(["heap", "toast", "index", "total"], s)), {t: size(conn, t) for t in tabs}


def reads(conn, docs, schema):
    out = {}
    for q in "abc":
        rnd = random.Random(11 + ord(q))
        args = []
        for _ in range(200):
            c = rnd.randrange(1, len(docs) + 1)
            d = docs[c - 1]
            args.append({"c": c, "p": rnd.choice(d["pages"])["page"], "k": rnd.randrange(max(1, len(d["parts"])))})
        with conn.cursor() as cur:
            for a in args:  # warm every page the timed calls touch
                cur.execute(READS[(schema, q)], a, prepare=True)
                cur.fetchall()
            ts, nrows = [], 0
            for a in args:
                t0 = time.perf_counter()
                cur.execute(READS[(schema, q)], a, prepare=True)
                nrows += len(cur.fetchall())
                ts.append((time.perf_counter() - t0) * 1000)
        ts.sort()
        out[q] = (round(statistics.median(ts), 3), round(ts[189], 3), nrows / 200)
    return out


def variants(conn, docs, npages):
    res = {}
    for schema in "AB":
        for lz4 in (False, True):
            load_s, s, per = load(conn, docs, schema, lz4)
            v = {"load_s": round(load_s, 2), "sizes": s, "per_table": per, "bytes_per_page": round(s["total"] / npages),
                 "gb_2_55M": round(s["total"] / npages * 2.55e6 / 1e9, 2), "gb_3_14M": round(s["total"] / npages * 3.14e6 / 1e9, 2),
                 "reads_ms_median_p95_rows": reads(conn, docs, schema)}
            if schema == "A":
                q = READS[("A", "b")].replace("%(c)s", "5").replace("%(k)s", "40")
                v["explain_b"] = [x[0] for x in conn.execute("explain analyze " + q).fetchall()]
            res[f"{schema} {'lz4' if lz4 else 'pglz'}"] = v
    return res


def usecases(conn, docs, npages):
    conn.execute(DDL_BOTH)
    with conn.cursor() as cur:
        for i, d in enumerate(docs, 1):
            cur.execute("insert into conv values (%s,%s)", (i, d["sha"]))
            write_a(cur, i, d)
            write_b(cur, i, d)
    conn.execute("vacuum analyze")
    big = max(range(len(docs)), key=lambda j: len(docs[j]["parts"])) + 1

    def args_for(q):
        rnd = random.Random(ord(q))
        out = []
        for _ in range(200):
            c = rnd.randrange(1, len(docs) + 1)
            ends = [p["end"] for p in docs[c - 1]["parts"] if p["end"] is not None]
            out.append({"c": c, "x": rnd.randrange(max(ends)) if ends else 0})
        return out

    def timed(q, args):
        with conn.cursor() as cur:
            for a in args:
                cur.execute(USES[q], a, prepare=True)
                cur.fetchall()
            ts, n = [], 0
            for a in args:
                t0 = time.perf_counter()
                cur.execute(USES[q], a, prepare=True)
                n += len(cur.fetchall())
                ts.append((time.perf_counter() - t0) * 1000)
        ts.sort()
        return round(statistics.median(ts), 3), round(ts[int(len(ts) * .95) - 1] if len(ts) > 1 else ts[0], 3), round(n / len(args), 2)

    R = {"big_conv_parts": len(docs[big - 1]["parts"]), "big_conv_pages": len(docs[big - 1]["pages"])}
    R["d_A"] = timed("d_A", args_for("d"))
    R["d_B"] = timed("d_B", args_for("d"))
    R["d_A_big"] = timed("d_A", [{"c": big}] * 20)
    R["d_B_big"] = timed("d_B", [{"c": big}] * 20)
    R["e_A"] = timed("e_A", args_for("e"))
    R["e_B_noidx"] = timed("e_B", args_for("e"))
    R["f_A"] = timed("f_A", args_for("f"))
    R["f_B_noidx"] = timed("f_B", args_for("f"))
    conn.execute("create index parts_b_start on parts_b (conversion, start_at)")
    conn.execute("create index parts_b_kind on parts_b (conversion, kind)")
    conn.execute("analyze parts_b")
    R["e_B_idx"] = timed("e_B", args_for("e"))
    R["f_B_idx"] = timed("f_B", args_for("f"))
    R["plans"] = {k: [x[0] for x in conn.execute("explain " + USES[k], {"c": 5, "x": 100}).fetchall()] for k in ("e_B", "f_B")}
    conn.execute("drop index parts_b_start; drop index parts_b_kind")
    scale = 2.55e6 / npages
    for k in ("g_A", "g_B", "h_A", "h_B"):
        ts = []
        for _ in range(4):  # the first run warms
            t0 = time.perf_counter()
            rows = conn.execute(USES[k]).fetchall()
            ts.append((time.perf_counter() - t0) * 1000)
        ts = ts[1:]
        R[k] = {"runs_ms": [round(t, 1) for t in ts], "rows": len(rows), "scaled_s_2_55M": round(statistics.median(ts) * scale / 1000, 1)}
    # (i) write: delete, then insert the file with the most parts, 3 times
    for sch, write, dels in (("A", write_a, ["delete from pages_a where conversion=%s"]),
                             ("B", write_b, ["delete from parts_b where conversion=%s", "delete from pages_b where conversion=%s"])):
        dt, it = [], []
        for _ in range(3):
            with conn.transaction():
                t0 = time.perf_counter()
                for s in dels:
                    conn.execute(s, (big,))
            dt.append((time.perf_counter() - t0) * 1000)
            with conn.transaction():
                t0 = time.perf_counter()
                write(conn.cursor(), big, docs[big - 1])
            it.append((time.perf_counter() - t0) * 1000)
        R[f"i_{sch}"] = {"delete_ms": [round(x, 1) for x in dt], "insert_ms": [round(x, 1) for x in it]}
    return R


def main(root, count, seed):
    t0 = time.time()
    docs, raw_bytes, noncontig = prepare(root, count, seed)
    npages = sum(len(d["pages"]) for d in docs)
    head = {"files": len(docs), "seed": seed, "pages": npages, "parts": sum(len(d["parts"]) for d in docs),
            "raw_bytes_per_page": round(raw_bytes / npages), "noncontig_pages": noncontig, "prep_s": round(time.time() - t0, 1)}
    for _ in range(60):
        try:
            conn = psycopg.connect(os.environ["PARTS_DSN"], autocommit=True)
            break
        except psycopg.OperationalError:
            time.sleep(1)
    else:
        sys.exit("cannot connect to PARTS_DSN")
    head["server_version"] = conn.execute("show server_version").fetchone()[0]
    print(json.dumps({**head, "variants": variants(conn, docs, npages), "usecases": usecases(conn, docs, npages)}, indent=1))


if __name__ == "__main__":
    main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 300, int(sys.argv[3]) if len(sys.argv) > 3 else 7)
