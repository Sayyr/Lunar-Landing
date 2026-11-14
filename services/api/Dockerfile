FROM gcc:14 AS calculator
WORKDIR /src
COPY simulation/simulate.cpp simulation/simulate-slow.c ./
RUN g++ -O2 -static -o simulate simulate.cpp \
  && gcc -O2 -static -o simulate-slow simulate-slow.c

FROM rust:1-slim-bookworm AS build
WORKDIR /app
COPY Cargo.toml ./
COPY src ./src
RUN cargo build --release

FROM debian:bookworm-slim
COPY --from=calculator /src/simulate /usr/local/lib/lunar-landing/calc-planete
COPY --from=calculator /src/simulate-slow /usr/local/lib/lunar-landing/calc-radio
COPY --from=build /app/target/release/lunar-landing /usr/local/bin/lunar-landing
EXPOSE 3000
CMD ["lunar-landing"]
