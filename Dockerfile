# syntax=docker/dockerfile:1

# The server as a container: the Streamable HTTP transport on PORT (8000 unless
# set), serving /mcp and /healthz, for a deployment that runs this server
# beside the application that calls it. Multi-stage: a build stage with the
# dev toolchain, a runtime stage with production dependencies only.
#
# Build and run:
#   docker build -t socrata-mcp-server .
#   docker run --rm -p 8000:8000 socrata-mcp-server
#   curl -fsS http://127.0.0.1:8000/healthz
#
# Configuration is RUN-time only: no environment file enters the build context
# (see .dockerignore), and nothing here reads one. Every setting the server
# honours is an environment variable named in README.md ("Run in a container").
#
# The base image is an argument so a deployment pipeline can substitute its own
# (a mirrored or hardened Node 22 image); the default is the image the
# application in front of this server builds from.
ARG NODE_IMAGE=node:22-bookworm-slim

# --- build -----------------------------------------------------------------
# The full dependency set (tsc lives in devDependencies), then the same two
# steps CI runs: `clean` and `build:tsc`. Not `npm run build`, whose
# prebuild-check step prints ~1,100 lines of SDK diagnostics and emits nothing.
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run clean && npm run build:tsc

# --- production dependencies -----------------------------------------------
# Installed from the lockfile with devDependencies omitted, in a stage of their
# own so the runtime image never carries the toolchain, and so a source change
# does not reinstall them.
FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# package.json is load-bearing at run time: its `"type": "module"` is what
# makes Node load dist/*.js as ES modules.
COPY package.json ./

# Unprivileged. The image's `node` user (uid 1000); nothing under /app needs
# to be writable, and the server writes no file, so a read-only root
# filesystem works (`docker run --read-only`; measured in CI).
USER node

# The code's default port when PORT is unset (src/index.ts).
EXPOSE 8000

# The same command as `npm run start`, without npm in front of it so signals
# reach the server and its graceful shutdown runs. `-r dotenv/config` is kept
# for parity with that script: with no .env file present it does nothing.
#
# No HEALTHCHECK: this image has no curl, so a probe would spawn a Node
# process every interval, and the orchestrators this is for (ECS task
# definitions, Render's healthCheckPath) define their own probe. The path to
# give them is /healthz.
CMD ["node", "-r", "dotenv/config", "./dist/index.js"]
