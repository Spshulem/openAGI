# OpenAGI multi-arch Docker image. amd64 + arm64. Pamir.ai-class boxes use arm64.
#
# Published by .github/workflows/docker.yml to GHCR — NOT Docker Hub. Pin a
# release tag; :latest is a moving target and `docker compose pull` /
# Watchtower will follow it unattended.
#
#   docker run -d --name openagi \
#     -p 43210:43210 \
#     -v openagi-data:/data \
#     -e OPENAGI_AUTH_TOKEN="$(openssl rand -hex 32)" \
#     -e ANTHROPIC_API_KEY=... \
#     ghcr.io/spshulem/openagi:v0.0.10
#
# OPENAGI_AUTH_TOKEN is REQUIRED here, not optional: HOST below is 0.0.0.0 (a
# container has to bind the wildcard for a published port to reach it), and the
# daemon refuses to start on a non-loopback bind with no token — otherwise
# `-p 43210:43210` would put the dashboard and full API on your LAN with no
# credential. See checkBindSafety() in src/auth.js.
#
# Then visit http://<host>:43210/?token=<the token> — the first-run wizard
# collects keys and the token is stored in a cookie from then on.

FROM node:22-alpine AS test
WORKDIR /build
COPY package.json ./
COPY src ./src
COPY examples ./examples
COPY test ./test
RUN node --test || (echo "tests failed in build" && exit 1)

FROM node:22-alpine
LABEL org.opencontainers.image.source="https://github.com/Spshulem/openAGI"
LABEL org.opencontainers.image.description="OpenAGI: always-on local agent host with directional adaptive scrutiny, tiered memory, and bounded propagation."
LABEL org.opencontainers.image.licenses="PolyForm-Noncommercial-1.0.0"

# Run as non-root.
RUN addgroup -g 1001 openagi && adduser -D -u 1001 -G openagi openagi

WORKDIR /opt/openagi
COPY --chown=openagi:openagi package.json ./
COPY --chown=openagi:openagi src ./src
COPY --chown=openagi:openagi examples ./examples

# Persistent state lives at /data so users mount a volume there.
RUN mkdir -p /data && chown openagi:openagi /data
ENV OPENAGI_DATA_DIR=/data
# A container must bind the wildcard or a published port can't reach it. That
# makes OPENAGI_AUTH_TOKEN mandatory — src/boot.js refuses to start without one
# on a non-loopback bind. Deliberately NOT defaulted here: a baked-in default
# token would be identical in every install, which is worse than no token.
ENV HOST=0.0.0.0
ENV PORT=43210

USER openagi
EXPOSE 43210
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:43210/health > /dev/null || exit 1

CMD ["node", "examples/hosted-server.js"]
