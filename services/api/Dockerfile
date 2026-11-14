FROM gcc:14 AS calculator
WORKDIR /src
COPY services/api/simulation/simulate.cpp services/api/simulation/simulate-slow.c ./
RUN g++ -O2 -static -o simulate simulate.cpp \
  && gcc -O2 -static -o simulate-slow simulate-slow.c

FROM rust:1-slim-bookworm AS build
WORKDIR /app/services/api
COPY packages/contracts/fixtures/sites.json /app/packages/contracts/fixtures/sites.json
COPY services/api/Cargo.toml services/api/Cargo.lock ./
COPY services/api/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=calculator /src/simulate /usr/local/lib/lunar-landing/calc-planete
COPY --from=calculator /src/simulate-slow /usr/local/lib/lunar-landing/calc-radio
COPY --from=build /app/services/api/target/release/lunar-landing /usr/local/bin/lunar-landing
EXPOSE 8080
CMD ["lunar-landing"]
