FROM debian:bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends g++ cmake make ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY services/science services/science
RUN cmake -S services/science -B build -DCMAKE_BUILD_TYPE=Release -DSELENE_BUILD_TESTS=OFF \
    && cmake --build build -j --target selene-science

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/selene-science /usr/local/bin/selene-science
EXPOSE 8000
CMD ["selene-science", "--host", "0.0.0.0", "--port", "8000"]
