# sciencepy — former Python science service (reference only)

This is the original Python/FastAPI implementation of the science service. It was ported to C++ in
`services/science`, which is the one that is built, tested and deployed.

This folder is kept **for reference only**: it is not built, tested or deployed (no CI job, no Docker
image, not in `infra/compose.yaml`). Paths inside it (Dockerfile, `scripts/`, tests) still refer to
the old `services/science` layout and are not maintained.
