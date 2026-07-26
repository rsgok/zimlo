FROM node:24-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/push-relay/package.json apps/push-relay/package.json
RUN corepack enable && pnpm install --filter @zimlo/push-relay... --frozen-lockfile
COPY apps/push-relay apps/push-relay
RUN pnpm --filter @zimlo/push-relay build
RUN pnpm --filter @zimlo/push-relay deploy --prod --legacy /out

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /out ./
CMD ["node", "dist/server.js"]
