# syntax=docker/dockerfile:1

FROM oven/bun:1.3.14-slim AS builder

WORKDIR /app

COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile

COPY src ./src

RUN mkdir -p /out \
  && bun build \
    --compile \
    --minify \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --outfile /out/moex \
    src/index.ts \
  && /out/moex --version

FROM debian:bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r moex \
  && useradd -r -g moex -d /home/moex -m moex \
  && mkdir -p /data /workspace \
  && chown -R moex:moex /data /workspace

COPY --from=builder /out/moex /usr/local/bin/moex

ENV MOEX_DB_PATH=/data/tasklist.db

VOLUME ["/data"]
WORKDIR /workspace
USER moex

ENTRYPOINT ["/usr/local/bin/moex"]
CMD ["serve"]
