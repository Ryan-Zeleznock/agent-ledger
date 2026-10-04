# Slice 2b pin 10: the `everything` legacy-era upstream (@modelcontextprotocol/server-everything 2026.8.31, SDK 1.x).
# Built by its own Kaniko Job from `git archive HEAD:deploy/upstreams/everything` (HOMELAB step 4b). Base images are
# pinned by index digest (resolved from the registries 2026-10-04; see deploy/README.md "Digest pins").
FROM node:24-alpine3.24@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
# The lockfile pins every package by sha512 integrity; ci refuses a lock/manifest mismatch; no install scripts run.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
USER 65532
EXPOSE 3001
CMD ["node_modules/@modelcontextprotocol/server-everything/dist/index.js", "streamableHttp"]
