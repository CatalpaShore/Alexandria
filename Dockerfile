FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack pnpm@11.7.0 install --frozen-lockfile
COPY tsconfig.json vite.config.ts ./
COPY server ./server
COPY client ./client
COPY scripts ./scripts
RUN corepack pnpm@11.7.0 run build && corepack pnpm@11.7.0 prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATA_DIR=/app/data AMW_LAN_MODE=true AMW_LAN_AUTH=true
ENV MEDIA_SOURCES="LOCAL:Library=/media" AMW_AGENT_ENABLED=false METADATA_AUTO_ENRICH=false
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/* && mkdir -p /app/data /media && chown -R node:node /app/data /media
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json LICENSE ./
COPY --chown=node:node scripts/config ./scripts/config
COPY --chown=node:node scripts/lib ./scripts/lib
COPY --chown=node:node scripts/create-demo.mjs scripts/start-demo.mjs ./scripts/
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
EXPOSE 3000
CMD ["node","dist/server/index.js"]

FROM runtime AS webview-runtime
ENV PORT=5188 DISCOVERY_PORT=3000
EXPOSE 5188
CMD ["node","dist/server/discoveryGateway.js"]

FROM runtime AS default-runtime
