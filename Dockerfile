# Node 24 (current LTS). Same image serves two roles: the web app and the
# one-shot migration job — only the command differs.
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

USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
