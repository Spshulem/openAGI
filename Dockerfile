# OpenAGI multi-arch Docker image. amd64 + arm64. Pamir.ai-class boxes use arm64.
#
#   docker run -d --name openagi \
#     -p 43210:43210 \
#     -v openagi-data:/data \
#     -e ANTHROPIC_API_KEY=... \
#     openagi/openagi:latest
#
# Then visit http://<host>:43210/ — first-run wizard collects keys.

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
ENV HOST=0.0.0.0
ENV PORT=43210

USER openagi
EXPOSE 43210
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=10s \
  CMD wget -qO- http://127.0.0.1:43210/health > /dev/null || exit 1

CMD ["node", "examples/hosted-server.js"]
