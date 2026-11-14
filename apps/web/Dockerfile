# Data stage: downloads the NASA/IAU data with the same script as local setup. Own stage so the
# layer stays cached across code changes; it only re-downloads when apps/web/scripts/ changes.
FROM debian:bookworm-slim AS data
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 imagemagick \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/web/scripts ./scripts
RUN scripts/setup-data.sh

FROM node:24-slim AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
COPY --from=data /app/public/data ./public/data
RUN npm run build

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
