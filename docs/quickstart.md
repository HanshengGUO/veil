# Quickstart: inspect your own CSV

This pre-alpha quickstart is the Stage 2 onboarding path: declare what your rows mean in time, read
your own CSV through the mandatory temporal guard, and inspect the resulting evidence and
degradations. It runs from a source checkout because no Veil package is published yet.

It does **not** issue a verified return, Sharpe ratio, or Experiment. The end-user
exploration-to-promotion command arrives with the Stage 3 Pi package. Today, the structural
promotion path is demonstrated by the committed walk-forward and golden-path examples.

## Before you start

You need Git and Node 20.10 or newer. Keep the CSV local; do not commit it, paste its rows into an
issue, or put credentials or an absolute path in the adapter.

```bash
git clone https://github.com/HanshengGUO/veil.git
cd veil
npm install
npm run engine:runtime:smoke
```

The runtime probe should report one DuckDB row and two Arrow rows. If installation or the probe
fails, stop the trial timer and record the operating system, CPU architecture, Node version, and
public error message. Do not include data paths or credentials.

## 1. Write one adapter

Save this as `adapter.yaml` next to your CSV and change the dataset name and four column/file names.
This conservative form works when your file has no trustworthy “first known at” timestamp:

```yaml
dataset: my-prices
version: "1"
entity_key: ticker
event_time: date
available_time: null
payload_schema:
  close: float64
source:
  type: csv
  locator: prices.csv
```

`source.locator` is relative to the root you pass at runtime. It is portable and non-secret. The
runtime root is a separate local capability and never enters the declaration or read-set identity.

With `available_time: null`, Veil filters conservatively on `event_time` and reports `PIT_UNSAFE`.
That is an honest, usable exploration result—not a validation failure. If your file really records
when each value first became knowable, declare it explicitly:

```yaml
available_time: first_known_at
availability_basis: observed
guarantees:
  point_in_time: true
```

Do not label downloaded history `observed` merely because an availability-like column exists. Use
`reconstructed` or `assumed` as described in [Dataset adapters](./adapters.md) when that is what the
timestamp represents.

## 2. Run the guarded read

From the repository root, replace the paths, decision time, and projected columns:

```bash
npm run data:inspect -- --adapter ./my-data/adapter.yaml --root ./my-data --as-of 2026-08-12 --columns ticker,close
```

Relative paths are resolved only by this local launcher. The JSON report contains no physical root
or source rows. Its important fields are:

- `view.asOf`, `rowCount`, and `columns`: the normalized cutoff and guarded panel shape;
- `guard.mandatoryArrowGuardApplied`: always `true`; backend pushdown is only an optimization;
- `semantics.degradations`: trust limits that must follow the data downstream;
- `evidence`: content identities for the exact declaration, query, source, and Arrow result.

Use `--preview 5` only when printing up to five guarded rows in your local terminal is acceptable.
Preview is opt-in and capped at 20. `droppedByArrowGuard` may be zero even when future rows existed:
the default backend can remove valid future timestamps first, after which the mandatory Arrow guard
checks the returned rows again. The safety property is that no row after `asOf` appears in the
preview or Arrow result, regardless of pushdown.

For the committed three-row future-sentinel check, run:

```bash
npm run csv-pit:verify
```

It must report `futureRowsVisible: false`. Your own-data command succeeds when it emits
`"ok": true`, the output columns are the ones you intended, the cutoff row count is plausible, and
every degradation is understood rather than silently discarded.

## 3. Choose the next boundary

- For unrestricted analysis, consume the guarded Arrow panel through the API documented in
  [`veil-data.md`](./veil-data.md). A panel remains `exploration-grade`.
- For durable evidence, explicitly write and cold-replay a read-set snapshot as documented in
  [`read-sets.md`](./read-sets.md). Reads never persist implicitly.
- To package a factor, continue to [`artifacts.md`](./artifacts.md). A structural promotion candidate
  remains `unverified` until the future pricing and statistical gates exist.

## External 30-minute trial checklist

This checklist is for a person who did not implement the feature. Start the timer before reading
this page and use only public repository documentation.

- [ ] Record the commit, operating system, architecture, `node --version`, and `npm --version`.
- [ ] Use a real CSV not committed in this repository; record only its approximate rows and columns.
- [ ] Install dependencies and pass `npm run engine:runtime:smoke`.
- [ ] Create an adapter without copying a physical root, credential, DSN, or token into it.
- [ ] Run `npm run data:inspect` without editing TypeScript or Veil source files.
- [ ] Explain which timestamp Veil filtered and why each reported degradation is present.
- [ ] Confirm that the report contains no physical root or credential value.
- [ ] Reach the successful report within 30 minutes, or record the exact step that prevented it.

Copy this small record into the review issue or pull request; never attach the data or private paths:

```text
Commit:
OS / architecture:
Node / npm:
Approximate CSV shape:
Minutes to first successful report:
Adapter changes beyond the template:
Unexpected error code and remedy (if any):
First unclear documentation step:
Did any output expose a physical root or secret? yes/no
Outcome: pass / blocked
```

An external pass is evidence about usability, not a substitute for contract tests. A blocked trial
is useful: fix the public instruction or diagnostic that caused it, then preserve the report rather
than rewriting the result as a pass.
