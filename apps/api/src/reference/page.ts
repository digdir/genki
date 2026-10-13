export const referencePage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>API reference</title>
    <link rel="stylesheet" href="reference/app.css" />
    <script type="module" src="reference/app.js"></script>
  </head>
  <body>
    <header class="top">
      <div class="top-inner">
        <div>
          <h1 id="title">API reference</h1>
          <p class="muted" id="meta">Loading /openapi.json</p>
        </div>
        <label class="search">
          <span class="visually-hidden">Search operations</span>
          <input id="search" type="search" placeholder="Search path, summary or schema name" autocomplete="off" />
        </label>
      </div>
    </header>
    <div class="layout">
      <nav id="nav" aria-label="Areas"></nav>
      <main id="content" tabindex="-1">
        <noscript>This page needs JavaScript. The raw document is at <a href="openapi.json">/openapi.json</a>.</noscript>
      </main>
    </div>
  </body>
</html>
`;

export const referenceStyles = `:root {
  --bg: #ffffff;
  --surface: #f6f7f9;
  --border: #d9dde3;
  --text: #1b1f24;
  --muted: #5b6470;
  --accent: #0062ba;
  --code: #eef1f5;
  --get: #0b7a3e;
  --post: #0062ba;
  --put: #8a5a00;
  --patch: #6f3fb5;
  --delete: #b3261e;
  --other: #5b6470;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14171b;
    --surface: #1c2026;
    --border: #333a43;
    --text: #e6e9ed;
    --muted: #9aa4b0;
    --accent: #6cb4ff;
    --code: #232931;
    --get: #5fd38d;
    --post: #6cb4ff;
    --put: #f0b84a;
    --patch: #c49bff;
    --delete: #ff8a80;
    --other: #9aa4b0;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
a { color: var(--accent); }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: var(--code); padding: 0 4px; border-radius: 4px; }
h1 { font-size: 1.4rem; margin: 0; }
h2 { font-size: 1.25rem; margin: 0 0 4px; }
h3 { font-size: 1rem; margin: 16px 0 6px; }
.muted { color: var(--muted); margin: 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.top { position: sticky; top: 0; z-index: 2; background: var(--bg); border-bottom: 1px solid var(--border); }
.top-inner { max-width: 1280px; margin: 0 auto; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; }
.search input { width: min(420px, 100%); padding: 8px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text); font: inherit; }
.search { flex: 1 1 260px; display: flex; justify-content: flex-end; }
.layout { max-width: 1280px; margin: 0 auto; padding: 16px; display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 24px; }
nav { position: sticky; top: 80px; align-self: start; max-height: calc(100vh - 100px); overflow: auto; }
nav ul { list-style: none; margin: 0; padding: 0; }
nav li a { display: flex; justify-content: space-between; gap: 8px; padding: 4px 8px; border-radius: 6px; text-decoration: none; color: var(--text); }
nav li a:hover { background: var(--surface); }
nav .count { color: var(--muted); }
section.tag { margin-bottom: 32px; scroll-margin-top: 90px; }
details.op { scroll-margin-top: 90px; }
section.tag > p { margin: 0 0 12px; color: var(--muted); max-width: 80ch; }
details.op { border: 1px solid var(--border); border-radius: 8px; margin: 6px 0; background: var(--bg); }
details.op[open] { background: var(--surface); }
details.op > summary { cursor: pointer; padding: 8px 12px; display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: baseline; list-style: none; }
details.op > summary::-webkit-details-marker { display: none; }
.method { display: inline-block; min-width: 64px; text-align: center; font-weight: 700; font-size: 0.8rem; text-transform: uppercase; border: 1px solid currentColor; border-radius: 4px; padding: 0 6px; }
.m-get { color: var(--get); }
.m-post { color: var(--post); }
.m-put { color: var(--put); }
.m-patch { color: var(--patch); }
.m-delete { color: var(--delete); }
.m-other { color: var(--other); }
.path { font-weight: 600; word-break: break-all; }
.summary { color: var(--muted); }
.op-body { padding: 0 12px 12px; border-top: 1px solid var(--border); }
.op-body p { max-width: 90ch; }
.deprecated { text-decoration: line-through; }
table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
th, td { text-align: left; vertical-align: top; padding: 4px 8px; border-bottom: 1px solid var(--border); }
th { color: var(--muted); font-weight: 600; }
.status { font-weight: 700; }
.s2 { color: var(--get); }
.s3 { color: var(--put); }
.s4, .s5 { color: var(--delete); }
.response { margin: 8px 0 12px; }
.ctype { color: var(--muted); font-size: 0.85em; margin-left: 8px; }
.schema { margin: 4px 0; padding-left: 0; list-style: none; }
.schema .schema { padding-left: 16px; border-left: 1px solid var(--border); margin-left: 4px; }
.schema li { margin: 2px 0; }
.prop { font-weight: 600; }
.req { color: var(--delete); font-size: 0.8em; margin-left: 4px; }
.type { color: var(--accent); }
.ref { color: var(--muted); font-style: italic; }
.desc { color: var(--muted); }
.enum code { margin-right: 4px; }
pre.example { background: var(--code); padding: 8px; border-radius: 6px; overflow: auto; max-height: 320px; margin: 4px 0; font-size: 0.85em; }
.empty { color: var(--muted); padding: 24px 0; }
.error { color: var(--delete); }
@media (max-width: 800px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  nav { position: static; max-height: none; }
}
`;
