# Circuit runs as one long-lived Node process. That is the whole reason this
# image exists: a persistent process can hold a Postgres pool, which is what
# lets storage be an ordinary database rather than an HTTP data API.
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
# Inlines the board into a single self-contained ui:// resource, then bundles
# the server to one file so the runtime image needs no node_modules of its own.
RUN npm run build:app && npm run build:server

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Railway sets PORT; this is the fallback for `docker run` on its own.
ENV PORT=8787

COPY --from=build /app/dist/server.js ./server.js

# Never run the server as root.
USER node
EXPOSE 8787
CMD ["node", "server.js"]
