# Node 24 (current LTS). Same image serves three roles: the web app,
# the one-shot migration job, and the daily pool CronJob — only the
# command differs.
FROM node:24-alpine AS base

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
# npm ci when a lockfile is committed; falls back to install for first run.
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY src ./src
COPY public ./public
COPY config ./config
COPY migrations ./migrations
COPY scripts ./scripts

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
