FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake make ca-certificates curl gzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
# CSPICE for the image's own platform (linux/amd64: NAIF prebuilt; linux/arm64: built from source),
# SHA-256 checked by the script. The kernels are NOT baked in: mount them at /data/kernels
# (infra/compose.yaml), after running scripts/setup-spice.sh --kernels on the host.
COPY scripts/setup-spice.sh scripts/setup-spice.sh
RUN scripts/setup-spice.sh --cspice
COPY services/science services/science
RUN cmake -S services/science -B build -DCMAKE_BUILD_TYPE=Release -DSELENE_BUILD_TESTS=OFF \
    && cmake --build build -j "$(nproc)" --target selene-science  # bare -j is unbounded with Make

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/selene-science /usr/local/bin/selene-science
EXPOSE 8000
CMD ["selene-science", "--host", "0.0.0.0", "--port", "8000"]
