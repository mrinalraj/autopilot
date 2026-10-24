# syntax=docker/dockerfile:1
FROM --platform=$BUILDPLATFORM oven/bun:1.3.14 AS frontend
WORKDIR /src/web
COPY web/package.json web/bun.lock ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

FROM --platform=$BUILDPLATFORM golang:1.26.2-bookworm AS backend
ARG TARGETOS=linux
ARG TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/web/dist ./web/dist
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags webassets -trimpath -ldflags='-s -w' -o /autopilot ./cmd/autopilot

FROM node:24-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client tmux tini ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 autopilot \
    && useradd --uid 10001 --gid autopilot --home-dir /data/agent-home --shell /bin/sh autopilot \
    && mkdir -p /data/agent-home /data/tools/bin \
    && chown -R autopilot:autopilot /data
COPY --from=backend /autopilot /usr/local/bin/autopilot
ENV AUTOPILOT_DATA_DIR=/data \
    AUTOPILOT_LISTEN=0.0.0.0:4780 \
    HOME=/data/agent-home \
    PATH=/data/tools/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
WORKDIR /data
USER autopilot
VOLUME ["/data"]
EXPOSE 4780
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD curl -fsS http://127.0.0.1:4780/healthz || exit 1
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "autopilot", "supervise"]
