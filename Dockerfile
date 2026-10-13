# syntax=docker/dockerfile:1.10
ARG NODE_IMAGE=node:24.21.0-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY . .
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npx tsc -b apps/api
RUN mkdir -p /out && \
    for dir in packages/* apps/*; do \
      mkdir -p "/out/$dir" && cp "$dir/package.json" "/out/$dir/" && \
      if [ -d "$dir/dist" ]; then cp -r "$dir/dist" "/out/$dir/"; fi; \
    done && \
    cp -r apps/api/config /out/apps/api/ && \
    cp package.json package-lock.json /out/

FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY --from=build /out/ ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund --workspace @genai/api

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /out/ ./
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
