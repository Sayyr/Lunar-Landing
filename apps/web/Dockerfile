# Data stage: downloads the NASA/IAU data with the same script as local setup. Own stage so the
# layer stays cached across code changes; it only re-downloads when apps/web/scripts/ changes.
FROM debian:bookworm-slim AS data
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 imagemagick \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY apps/web/scripts ./scripts
RUN scripts/setup-data.sh

# Slope-grid stage: the 4 km disc slope grid of the "South-pole grid" page, derived at image build from
# the raw LOLA LDEM_85S_20M (NASA PDS, 920 MB). The download is its own layer, before any source COPY,
# so Docker caches it: it runs once, not on every build. Size and SHA-256 are checked (hashes recorded
# from the PDS download on 2026-11-15). Only the ~2.8 MB grid reaches the web image.
FROM debian:bookworm-slim AS grid
RUN apt-get update \
 && apt-get install -y --no-install-recommends g++ cmake make ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /dem
ARG LDEM_BASE=https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/polar/float_img
ARG LDEM_IMG_SHA256=bbfd0295c7ae0759dd7b2513e1ebd61fd5e3d304e35b3fa2ae9e6840054d9b7a
ARG LDEM_LBL_SHA256=7ad5bed3dc8c4e48ace39f10b0f8aa5b8e1eff8bcece89f89ed11297a9ff04ed
RUN curl -fsSL --retry 3 -o ldem_85s_20m_float.lbl "$LDEM_BASE/ldem_85s_20m_float.lbl" \
 && curl -fsSL --retry 3 -o ldem_85s_20m_float.img "$LDEM_BASE/ldem_85s_20m_float.img" \
 && test "$(stat -c%s ldem_85s_20m_float.img)" = 920272896 \
 && printf '%s  %s\n' "$LDEM_IMG_SHA256" ldem_85s_20m_float.img "$LDEM_LBL_SHA256" ldem_85s_20m_float.lbl | sha256sum -c -
WORKDIR /src
COPY services/science services/science
RUN cmake -S services/science -B build -DCMAKE_BUILD_TYPE=Release -DSELENE_BUILD_TESTS=OFF \
 && cmake --build build -j "$(nproc)" --target slope-grid
RUN build/slope-grid /dem/ldem_85s_20m_float.img /dem/ldem_85s_20m_float.lbl /out/polar_s_grid/grid_4km.json \
      --source-sha256 "$LDEM_IMG_SHA256"

FROM node:24-slim AS build
WORKDIR /app
COPY apps/web/package.json apps/web/package-lock.json ./
RUN npm ci
COPY apps/web ./
COPY --from=data /app/public/data ./public/data
COPY --from=grid /out/polar_s_grid ./public/data/polar_s_grid
RUN npm run build

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
