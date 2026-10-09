FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN npm ci

COPY apps/api apps/api
COPY packages/shared-types packages/shared-types
RUN npm run build --workspace=apps/api

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
COPY --from=build /app/apps/api/dist ./apps/api/dist
COPY --from=build /app/apps/api/db/migrations ./apps/api/db/migrations
COPY --from=build /app/packages/shared-types ./packages/shared-types
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
