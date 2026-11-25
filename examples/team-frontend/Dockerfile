# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b
FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS build
WORKDIR /app
COPY package.json tsconfig.json genki.ts i18n.ts app.ts ./
RUN npm install --no-save --ignore-scripts --no-audit --no-fund typescript@6.0.3 && npx tsc -p .

FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:b5047b9b76845eac124358373c6852377c52e4b05834a47647e955dd91cb8f1e
COPY --chmod=755 defaults.envsh /docker-entrypoint.d/15-defaults.envsh
COPY default.conf.template /etc/nginx/templates/default.conf.template
COPY index.html styles.css /usr/share/nginx/html/
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 8080
