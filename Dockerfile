# syntax=docker/dockerfile:1.10
ARG NODE_IMAGE=node:24.21.0-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npx tsc -b apps/api apps/worker
RUN mkdir -p /out && \
    for dir in packages/* apps/*; do \
      mkdir -p "/out/$dir" && cp "$dir/package.json" "/out/$dir/" && \
      if [ -d "$dir/dist" ]; then cp -r "$dir/dist" "/out/$dir/"; fi; \
    done && \
    for asset in $(cat docker/runtime-assets); do \
      mkdir -p "/out/$(dirname "$asset")" && cp -r "$asset" "/out/$asset" || exit 1; \
    done && \
    node scripts/docs-bundle.ts /out/genki-docs && \
    cp package.json package-lock.json /out/

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=build /out/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    --workspace @genai/api --workspace @genai/worker

FROM ${NODE_IMAGE} AS node-runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /out/ ./
USER node

FROM build AS apps-build
RUN for app in portal workspace console; do \
      (cd "apps/$app" && npx vite build --outDir "/web/$app") || exit 1; \
    done
RUN find /web -type f \( -name '*.js' -o -name '*.css' -o -name '*.svg' -o -name '*.html' \) \
      -size +1k -exec gzip -9 -k -n {} +

FROM ${NGINX_IMAGE} AS apps
COPY --from=apps-build /web /usr/share/nginx/html
COPY docker/apps/default.conf.template /etc/genki/default.conf.template
COPY docker/apps/headers.conf /etc/nginx/genki-headers.conf
COPY --chmod=755 docker/apps/30-genki-config.sh /docker-entrypoint.d/30-genki-config.sh
EXPOSE 8080

FROM node-runtime AS worker
CMD ["node", "apps/worker/dist/main.js"]

FROM node-runtime AS api
ENV PORT=8080
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
