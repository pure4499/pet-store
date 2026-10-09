FROM node:22-bookworm-slim AS build

ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/admin/package.json apps/admin/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN npm ci
COPY apps/admin apps/admin
COPY packages/shared-types packages/shared-types
RUN npm run build --workspace=apps/admin

FROM nginx:1.29-alpine
COPY --from=build /app/apps/admin/dist /usr/share/nginx/html
COPY apps/admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
