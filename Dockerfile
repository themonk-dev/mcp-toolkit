# syntax=docker/dockerfile:1.7

# -----------------------------------------------------------------------------
# deps — install workspace dependencies using manifests only, so the install
# layer caches independently of source changes.
# -----------------------------------------------------------------------------
FROM oven/bun:1-slim@sha256:7e8ed3961db1cdedf17d516dda87948cfedbd294f53bf16462e5b57ed3fff0f1 AS deps
WORKDIR /app

COPY package.json bun.lock bunfig.toml ./
COPY apps/server/package.json ./apps/server/package.json
COPY packages/auth/package.json ./packages/auth/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/mcp-client/package.json ./packages/mcp-client/package.json
COPY packages/policy/package.json ./packages/policy/package.json
COPY packages/prompts/package.json ./packages/prompts/package.json
COPY packages/proxy-tools/package.json ./packages/proxy-tools/package.json
COPY packages/resources/package.json ./packages/resources/package.json
COPY packages/storage/package.json ./packages/storage/package.json
COPY packages/tools/package.json ./packages/tools/package.json
COPY packages/transport-http/package.json ./packages/transport-http/package.json

RUN bun install --frozen-lockfile --production

# -----------------------------------------------------------------------------
# runtime — overlay real source on top of the cached deps. Bun runs TS
# directly, so there is no build step.
# -----------------------------------------------------------------------------
FROM oven/bun:1-slim@sha256:7e8ed3961db1cdedf17d516dda87948cfedbd294f53bf16462e5b57ed3fff0f1 AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps --chown=bun:bun /app /app
COPY --chown=bun:bun tsconfig.base.json ./
COPY --chown=bun:bun apps/server ./apps/server
COPY --chown=bun:bun packages ./packages

# FileTokenStore writes to .data/tokens.json relative to cwd. Pre-create the
# dir with the right owner so a bind-mounted/volume mount inherits it.
RUN mkdir -p /app/apps/server/.data && chown -R bun:bun /app/apps/server/.data

USER bun
WORKDIR /app/apps/server

# 3000 = MCP HTTP transport. 3001 = OAuth Authorization Server, mounted only
# when AUTH.strategy is "oidc" or "oauth"; harmless to expose otherwise.
EXPOSE 3000 3001

CMD ["bun", "run", "src/main.ts"]
