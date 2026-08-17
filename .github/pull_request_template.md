## What and why

<!-- What changed, and what problem it solves. The diff already shows the what; spend the words on the why. -->

## Checklist

- [ ] `npm run check` passes (lint, typecheck, tests, golden-path reproduction)
- [ ] Documentation updated in `docs/`; mirrored core pages also update `docs/zh-CN/`
- [ ] `CHANGELOG.md` updated under `[Unreleased]`
- [ ] Numbers quoted in prose were regenerated, not typed by hand

## If this touches the contract, gates, tools, or prompts

- [ ] Bench safety did not regress, and I have said what happened to the numbers below

<!--
Safety may never regress, including in a change that improves everything else. A patch that raises
competence by ten points and lowers safety by one is a regression.

  safety:      before -> after
  competence:  before -> after
  G1/G2 share: before -> after
-->

## If this adds a mechanism

- [ ] I considered removing or unifying something instead, and said why that does not work

<!-- Few mechanisms strictly enforced beats many mechanisms loosely enforced. -->
