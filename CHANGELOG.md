# Changelog

All notable changes to this project are recorded here, following
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Versions are shared across all packages. C1-C6 contract semantics are stable from v0.1; other APIs
may change during 0.x, and every change appears here.

## [Unreleased]

### Added

- **Veil Contract v1.0** ([`docs/contract.md`](./docs/contract.md)): the six invariants, the
  guarantee-declaration and degradation rules, the `ContractViolation` shape, and the v1 threat
  model.
- **Golden path** ([`examples/golden-path`](./examples/golden-path)): the reference study, written by
  hand. A deterministic synthetic market (165 instruments, 2016-2024, with halts, delistings and a
  lagged fundamentals feed), one momentum factor evaluated under an honest protocol and seven
  variations, and a null-environment comparison. Metrics are committed and reproduced bit-identically
  on Linux, macOS and Windows.
- **Declaration formats**: draft schemas for
  [`adapter.yaml`](./packages/veil-contract/schemas/adapter.yaml) and
  [`artifact.yaml`](./packages/veil-contract/schemas/artifact.yaml), and a bench task template
  ([`bench/tasks/_TEMPLATE`](./bench/tasks/_TEMPLATE)) that doubles as the task contribution guide.
- **`@veilquant/contract`**: the invariant registry and `ContractViolation`.
- Package skeletons for `@veilquant/engine`, `veil-quant` (the Pi package users install), and the
  bench runner, each documenting what it delivers and when.
- Repository scaffolding: npm workspaces, TypeScript 7 strict with erasable syntax only, Biome,
  Vitest, and a three-platform CI matrix.

### Notes

- Nothing is installable yet. The first public release is v0.1, at the end of Stage 3.
