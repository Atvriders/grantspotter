# GrantSpotter — multi-stage, multi-arch (linux/amd64, linux/arm64).
#
# linux/amd64 covers the x86 servers, NAS boxes and VPSes most self-hosters run.
# linux/arm64 covers a 64-bit Raspberry Pi (3/4/5 on a 64-bit OS), an ARM VPS and
# Apple Silicon — a Pi is a realistic home for a club's ham radio tools, and it is
# the reason arm64 is a first-class target rather than an afterthought. 32-bit
# armv6/armv7 (Pi Zero, Pi 1, 32-bit Raspberry Pi OS) is NOT built: Node 20 has no
# supported 32-bit ARM release line for the official image tag this pins.
#
# No browser engine is installed: PDF output is the user's own "Save as PDF"
# against the print stylesheet. A bundled headless browser would add roughly
# 400 MB and its arm64 build under QEMU emulation is a recurring CI failure.
# The dockerfile test asserts that no browser package name appears in this file.

# ---------- build: compile core, server and the SPA ----------
FROM node:20.11.0-bookworm-slim AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
# better-sqlite3 is a native module. It ships prebuilt binaries for both target
# architectures, but falls back to compiling from source, so the toolchain has to
# be here: without it a missing prebuild turns into a build failure, not a slow build.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
# Manifests first: this layer is cached until a dependency actually changes, which
# is what keeps the emulated arm64 install off the critical path of most builds.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN npm ci
COPY . .
RUN npm run build

# ---------- deps: production-only node_modules ----------
FROM node:20.11.0-bookworm-slim AS deps
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/web/package.json ./packages/web/package.json
RUN npm ci --omit=dev

# ---------- runtime ----------
FROM node:20.11.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3030 \
    DATA_DIR=/data \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# npm workspaces link node_modules/@grantspotter/core to ../../packages/core, so the
# workspace manifests below are not optional: without the package.json at the far end
# of that symlink, `import '@grantspotter/core'` resolves to nothing at startup.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/server/package.json ./packages/server/package.json
COPY packages/web/package.json ./packages/web/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/web/dist ./packages/web/dist
# Read at runtime: the seed corpus, the ARRL section lookup table, and the templates
# and prompt fragments. seedDir() and webDistRoot() both resolve their paths relative
# to the compiled module, so the layout under /app has to mirror the repository.
COPY content ./content
COPY data/seed ./data/seed
COPY data/reference ./data/reference

# Only /data needs to be writable, and only by the app user. Everything under /app is
# left root-owned and world-readable: the running process has no business rewriting
# its own code, and `chown -R` on node_modules would duplicate the whole tree in a
# new layer for nothing.
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME ["/data"]
EXPOSE 3030

# A TCP connect, not an HTTP probe: it needs no curl, no wget and no assumption
# about which health route exists. `node -e` runs as CommonJS, so require() is fine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "const s=require('node:net').connect({host:'127.0.0.1',port:Number(process.env.PORT||3030)},()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(4000,()=>process.exit(1));"

CMD ["node", "packages/server/dist/index.js"]
