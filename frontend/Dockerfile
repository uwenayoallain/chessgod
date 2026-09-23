FROM node:22-alpine

WORKDIR /app

ENV PATH="/app/node_modules/.bin:${PATH}"

RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    SKIP_STOCKFISH_NNUE_DOWNLOAD=1 pnpm install --frozen-lockfile --ignore-scripts && \
    node scripts/sync-stockfish-assets.mjs

COPY . .

EXPOSE 5173

CMD ["vp", "dev", "--host", "0.0.0.0"]
