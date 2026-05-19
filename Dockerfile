# syntax=docker/dockerfile:1.7

# Multi-stage minimal image — agent-collab has zero npm dependencies,
# so we ship just Node 20 slim + the source.

FROM node:20-alpine

LABEL org.opencontainers.image.title="agent-collab"
LABEL org.opencontainers.image.description="Chair-authority multi-agent collaboration hub"
LABEL org.opencontainers.image.source="https://github.com/ruijiaang-lab/agent-collab"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Source first (tiny), package.json provides scripts metadata.
COPY package.json ./
COPY server.js ./
COPY public/ ./public/
COPY scripts/ ./scripts/

# Runtime state lives here. Mount a volume here to persist meetings across runs:
#   docker run -v $(pwd)/data:/app/data ...
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV NODE_ENV=production
ENV PORT=5057
EXPOSE 5057

# Minimal healthcheck — hit the state endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/api/state >/dev/null || exit 1

CMD ["node", "server.js"]
