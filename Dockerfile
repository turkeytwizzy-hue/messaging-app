FROM node:20-alpine

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

WORKDIR /app

# Copy workspace config
COPY pnpm-workspace.yaml package.json tsconfig.json ./

# Copy package manifests
COPY packages/core/package.json ./packages/core/
COPY apps/server/package.json ./apps/server/

# Install all dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY packages/core/ ./packages/core/
COPY apps/server/ ./apps/server/

WORKDIR /app/apps/server

# Run database migrations then start the server
CMD ["sh", "-c", "npx drizzle-kit migrate && npx tsx src/index.ts"]
