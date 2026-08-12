# Contributing to Veil

Three ways to contribute that do not require reading Veil's internals. All three are "add a file,
open a pull request".

| # | Contribution | Where | Available |
| --- | --- | --- | --- |
| 1 | **A bench task** — a research task with a planted flaw, or a clean one with a known answer | [`bench/tasks/_TEMPLATE`](./bench/tasks/_TEMPLATE) | now |
| 2 | **An adapter** — teach Veil to read a data source or format | `packages/veil-engine` + a declaration | Stage 2 |
| 3 | **A plugin** — a cost model or a null generator for an asset class | typed interface, `docs/gates.md` | Stage 4 |

## The most valuable contribution

**A leak you actually hit.** If something in your own research looked too good and turned out to be a
protocol artifact, that is worth more to this project than any synthetic idea. Veil's working rule is
that a newly discovered leak becomes a bench task *before* it becomes a fix — otherwise nothing stops
it from coming back.

Open an issue with the "leak report" template, or go straight to a task pull request. You do not need
to know how Veil would catch it; describing what fooled you is the contribution.

## Setup

Node 20 or newer.

```bash
git clone https://github.com/HanshengGUO/veil
cd veil
npm install
npm run check
```

`npm run check` runs lint, typecheck, tests, the four-task bench smoke set, and the golden-path
reproduction. It must pass before a pull request, and it is what CI runs on Linux, macOS and Windows.

Useful individually:

```bash
npm run lint:fix       # format and fix what can be fixed
npm run typecheck
npm run test
npm run bench:smoke    # generate and validate two trap plus two honest tasks
npm run golden-path    # regenerate the reference study and print its table
```

## Rules of the codebase

Two rules are specific to this project and matter more than style:

1. **Documentation ships with the change.** Every user-visible change updates its page in `docs/`.
   A feature without its documentation is not finished. The pull request template asks about this.
2. **Veil does not fork Pi.** Everything is a Pi extension or package. If an invariant seems to
   require changing Pi itself, the design is too invasive — the fix belongs in `veil-engine`. Say so
   in the issue rather than working around it.

And the ordinary ones:

- TypeScript, strict, no `any` unless there is genuinely no alternative.
- Top-level imports only. The one exception is the Pi runtime boundary: it checks Node 22.19 before
  dynamically loading Pi so model-free bench commands remain usable on the project's Node 20 floor.
- Comments explain *why*, when the why is not obvious. Code that needs a comment to say what it does
  usually needs a better name instead.
- No new dependency without a reason in the pull request. Direct dependencies are pinned exactly.
- Do not weaken a check to make a test pass. If a check is wrong, fix the check and say why.

## Numbers in documentation

Every metric in this repository is generated, not typed. If you change the golden path, run
`npm run golden-path`, commit the regenerated `results.json`, and update any prose that quotes it —
CI compares committed metrics against a fresh run on three platforms and fails on any difference.
That includes the table in the README.

## Bench: the one rule that constrains everyone

Safety may never regress, including in a change that improves everything else. A patch that raises
competence by ten points and lowers safety by one is a regression and will not be merged.

If your change affects the contract, the gates, the tools, or prompts, say what happened to the bench
numbers in the pull request.

## Pull requests

- One concern per pull request.
- Title as `area: what changed` — for example `engine: enforce embargo default`.
- Explain *why* in the description; the diff already shows what.
- Draft is fine and welcome. An early sketch saves both sides work when a design is wrong.

## Reporting a security issue

Do not open a public issue for something exploitable. See [`SECURITY.md`](./SECURITY.md).

Note the scope in [`docs/contract.md`](./docs/contract.md) section 6: Veil v1 defends against
carelessness and self-deception, not against a deliberately adversarial agent. A demonstration that
an agent can bypass the exploration surface is expected and documented. A demonstration that a
**verified claim** can be produced from leaked data is a real finding, and we want to hear about it.
