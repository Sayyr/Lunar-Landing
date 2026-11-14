FROM rust:1.94-slim-bookworm AS build
WORKDIR /src
# The binary embeds packages/contracts/fixtures/sites.json, so copy contracts too.
COPY packages/contracts packages/contracts
COPY services/api services/api
WORKDIR /src/services/api
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/services/api/target/release/selene-api /usr/local/bin/selene-api
EXPOSE 8080
CMD ["selene-api"]
