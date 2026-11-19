# Team frontend template

A frontend a team runs itself, registered in genki as a `browser` frontend of one service. People log in with Ansattporten, and the page calls genki with their token. The guide is [Run your own frontend](../../docs/run-your-own-frontend.md).

What is here:

- `genki.ts`: login (code flow with PKCE) and the calls to genki: services, a streamed answer with sources, threads and feedback. No dependencies and no imports from the genki repository; copy it.
- `app.ts`, `index.html`, `styles.css`: one page that logs in, asks, shows the answer as it streams, shows the cited sources and reopens earlier threads.
- `Dockerfile` and `default.conf.template`: an nginx image that serves the page, writes `/config.json` from the environment, proxies `/genki/` to genki and sets a strict CSP.
- `i18n.ts`: the page's texts in bokmål and English. The page starts in bokmål; its language button, or `?lang=en`, switches, and the login and genki's answers follow.
- `genki.test.ts`: the login, session, language and streaming rules, against a fake genki.

## Settings

| Variable          | Example                                     | What it is                                                              |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| `PUBLIC_URL`      | `https://assistent.example.no`              | Where this frontend is served; `/callback` under it is the redirect URI |
| `GENKI_API_URL`   | `https://api.genki-test.digdir.cloud`       | genki's API, as people's browsers see it                                |
| `GENKI_UPSTREAM`  | `http://host.docker.internal:8080`          | Optional: where the container reaches genki, if not `GENKI_API_URL`     |
| `OIDC_ISSUER`     | `https://test.ansattporten.no`              | The login issuer                                                        |
| `OIDC_CLIENT_ID`  | your Ansattporten client id                 | The same id as in the genki registration                                |
| `ALTINN_RESOURCE` | `urn:altinn:resource:digdir-genai-platform` | Optional: the Altinn resource the login asks rights for                 |
| `GENKI_SERVICE`   | `kunnskapsassistenten`                      | Optional: show only this service                                        |

## Build and run

```sh
npm install && npm test && npm run build
docker build -t team-frontend .
docker run -p 5195:8080 -e PUBLIC_URL=http://localhost:5195 \
  -e GENKI_API_URL=http://localhost:8080 -e GENKI_UPSTREAM=http://host.docker.internal:8080 \
  -e OIDC_ISSUER=http://localhost:8080/mock/ansattporten -e OIDC_CLIENT_ID=team-frontend \
  team-frontend
```

Against a local genki, register the frontend first (see the guide), then open http://localhost:5195 and pick a test person.

Inside the genki repository the tests run with the rest: `npx vitest run examples/team-frontend`.
