FROM python:3.12-slim-bookworm AS worker
COPY --from=ghcr.io/astral-sh/uv:0.10.6 /uv /usr/local/bin/uv
WORKDIR /app
COPY approaches/baseline/worker/ .
RUN uv sync --frozen --no-dev --no-editable
ENV PATH="/app/.venv/bin:$PATH"
CMD ["worker", "start"]

FROM node:22-bookworm-slim AS build
COPY --from=oven/bun:1.3.13 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY package.json bun.lock ./
COPY approaches/baseline/package.json approaches/baseline/
COPY approaches/baseline/mobile/package.json approaches/baseline/mobile/
COPY packages/floorplan/package.json packages/floorplan/
RUN bun install --frozen-lockfile --linker=hoisted --filter floorplan-tool-temp
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app/approaches/baseline
RUN bun run build

FROM node:22-bookworm-slim AS api
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /app/approaches/baseline/.next/standalone ./
WORKDIR /app/approaches/baseline
COPY --from=build /app/approaches/baseline/.next/static ./.next/static
COPY --from=build /app/approaches/baseline/public ./public
COPY --from=build /app/approaches/baseline/skills ./skills
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=8080
USER node
CMD ["node", "server.js"]
