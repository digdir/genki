"""Generate evaluation questions for the Kudos pilot's model comparison (genki issue 92): gpt-4o on Foundry writes
one question per randomly drawn page of the pilot index, in Bokmål or Nynorsk, and that page is the expected
answer. The draft test set's 76 questions stay apart; these are unreviewed and scored separately.

Pages come from digdir/kudos-next's active generation in the pilot's knowledge database (the same pages every
model embeds). Pages under 600 characters are skipped; gpt-4o may also refuse a page without a specific answer.

    python3 gen_questions.py [count]        # 600 by default: every sixth in Nynorsk

Settings: FOUNDRY_OPENAI_BASE_URL and FOUNDRY_OPENAI_KEY (environment or .env.local), QUESTION_MODEL (default
gpt-4o-2m-tps). Writes .data/generated-questions.json. Python 3.9 or later, standard library only.
"""
import concurrent.futures
import json
import os
import subprocess
import sys
import urllib.request

from common import DATA, REPO

KNOWLEDGE = "genki-kudos-pilot-knowledge-1"
DATASET = "digdir/kudos-next"
SEED = "kudos-pilot-questions-1"


def setting(name):
    if os.environ.get(name):
        return os.environ[name]
    for line in (REPO / ".env.local").read_text().splitlines():
        key, sep, rest = line.partition("=")
        if sep and key.strip() == name and rest.strip():
            return rest.strip().strip("'\"")
    raise SystemExit(f"{name} is not set")


def pages(count):
    # A fixed pseudo-random draw: the same pages every run
    sql = f"""
      select coalesce(json_agg(p), '[]') from (
        select c.id as chunk, c.doc_id as document, (c.metadata->>'page')::int as page, d.title, c.text
        from kn_chunks c
        join kn_active a on a.dataset = c.dataset and a.generation = c.generation
        join kn_docs d on d.dataset = c.dataset and d.generation = c.generation and d.id = c.doc_id
        where c.dataset = '{DATASET}' and length(c.text) >= 600
        order by md5(c.id || '{SEED}')
        limit {count}
      ) p"""
    out = subprocess.run(
        ["docker", "exec", KNOWLEDGE, "psql", "-U", "genai", "-d", "knowledge", "-Atc", sql],
        check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)


PROMPT = """You write evaluation questions for a search engine over Norwegian public-sector documents \
(annual reports, letters of allocation, evaluations, reports).

Below is one page from the document "{title}". Write ONE question in {language} that a civil servant might ask, \
which this page answers specifically. The question must make sense without seeing the page: name the agency, \
programme, place or year it concerns. Do not copy long phrases from the page; ask it the way a person would. \
If the page has no specific answerable content (a table of contents, a list of names, a blank or cover page), \
set usable to false.

Answer as JSON: {{"usable": true or false, "question": "...", "answer": "a short answer taken from the page"}}

Page:
{text}"""


def ask(item, base, key, model):
    body = {
        "model": model,
        "temperature": 0.2,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "user", "content": PROMPT.format(**item)}],
    }
    request = urllib.request.Request(
        base.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode(),
        headers={"api-key": key, "content-type": "application/json"},
    )
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                answer = json.loads(json.load(response)["choices"][0]["message"]["content"])
                return {**item, **answer}
        except Exception as error:  # noqa: BLE001
            if attempt == 3:
                return {**item, "usable": False, "error": str(error)}


def main():
    count = int(sys.argv[1]) if len(sys.argv) > 1 else 600
    base, key = setting("FOUNDRY_OPENAI_BASE_URL"), setting("FOUNDRY_OPENAI_KEY")
    model = os.environ.get("QUESTION_MODEL", "gpt-4o-2m-tps")
    drawn = pages(int(count * 1.25))
    for i, page in enumerate(drawn):
        page["language"] = "Nynorsk" if i % 6 == 5 else "Bokmål"
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        answered = list(pool.map(lambda p: ask(p, base, key, model), drawn))
    usable = [a for a in answered if a.get("usable") and str(a.get("question", "")).strip()][:count]
    questions = [
        {
            "id": f"gen-{i + 1:04d}",
            "language": "nn" if a["language"] == "Nynorsk" else "nb",
            "question": a["question"].strip(),
            "answer": str(a.get("answer", "")).strip(),
            "document": a["document"],
            "page": a["page"],
            "chunk": a["chunk"],
            "title": a["title"],
        }
        for i, a in enumerate(usable)
    ]
    out = DATA / "generated-questions.json"
    out.write_text(json.dumps({"model": model, "seed": SEED, "drawn": len(drawn), "questions": questions},
                              indent=1, ensure_ascii=False))
    refused = sum(1 for a in answered if not a.get("usable"))
    print(f"{len(questions)} questions ({sum(q['language'] == 'nn' for q in questions)} Nynorsk) from "
          f"{len(drawn)} pages; {refused} pages refused or failed; wrote {out}")


if __name__ == "__main__":
    main()
