# Minimal frontend

One HTML page and a tiny Node server that uses `@genai/client`. It lists the services the key can use, asks with a live stream and a server-side conversation, and shows sources by the `[N]` rule. See `docs/frontend-contract.md`.

```sh
PLATFORM_URL=http://localhost:8080 PLATFORM_KEY=<service key> \
  npx tsx --conditions=source examples/frontend-minimal/server.mjs
```

Open http://localhost:5190. The key stays on the server; the browser only talks to this server.
