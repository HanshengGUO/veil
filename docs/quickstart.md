# Quickstart: your first Veil research loop

This is the 30-minute path from a private CSV to a structurally verified promotion candidate inside
[Pi](https://github.com/badlogic/pi-mono). You keep the normal coding-agent workflow: explore with
files and scripts, then ask Veil to re-execute, price, and gate one packaged factor before it can
become a claim.

One boundary matters from the start: a request without a `stage4` block produces a
**contract-verified, unverified promotion candidate**. A complete Stage 4 request additionally prices
the retained OOS execution, audits trials, runs every gate, and archives a citable Experiment.

## 1. Install

Veil's libraries require Node 20.10 or newer. Use a Pi release compatible with your Node version;
the repository-pinned Pi 0.84.1 model runner requires Node 22.19 or newer. Until a registry release is
actually published, install from a source checkout and point Pi at the package:

```bash
git clone https://github.com/HanshengGUO/veil.git
cd veil
npm install
pi install ./packages/veil-agent
```

Pi packages execute with the user's permissions. Review third-party extension source before
installing it. Veil does not add a credential or sandbox to your shell; its security property is that
only the separate promotion surface can issue structural claim evidence.

## 2. Declare the CSV

In the project where you will start Pi, save this as `adapters/prices.yaml`. Change the dataset,
column names, and file name. Do not put an absolute path, DSN, token, or credential in this file.

```yaml
dataset: my-prices
version: "1"
entity_key: ticker
event_time: date
available_time: null
frequency: 1d
guarantees:
  point_in_time: false
  survivorship_free: false
  tradability_mask: tradable
payload_schema:
  close: float64
  volume: float64
source:
  type: csv
  locator: prices.csv
```

This conservative declaration is usable for guarded exploration even when downloaded history has no
trustworthy “first known at” timestamp. Veil filters on `event_time` and preserves `PIT_UNSAFE`; it
does not pretend the data is point-in-time safe. Promotion will reject this declaration as C1 because
later gates cannot repair missing point-in-time or survivorship evidence. If the file really records
when each value first became knowable, declare that column and its evidence honestly:

```yaml
available_time: first_known_at
availability_basis: observed
guarantees:
  point_in_time: true
  survivorship_free: true
  tradability_mask: tradable
```

Set `survivorship_free: true` only when the source genuinely includes point-in-time universe history;
a current constituent list is not sufficient. Historical data received in one backfill was not
“observed” arriving merely because it contains a date-like field. Use `reconstructed` or `assumed`
as described in [Dataset adapters](./adapters.md).

## 3. Register the local capability

Create `.veil/project.yaml` in the Pi working directory:

```yaml
format: veil.project.v0
datasets:
  - dataset: my-prices
    adapter: adapters/prices.yaml
    root: null
    root_env: VEIL_PRICES_ROOT
runtimes:
  - id: veil-node
    constraints:
      - ">=20.10.0,<30"
promotion_concurrency: 2
stage4:
  cost_models:
    - kind: linear-bps
      reference: equities-10bps
      basis_points: 10
  null_generators:
    - kind: centered-block-bootstrap
      reference: daily-centered-blocks
      replications: 1024
      block_length: 5
      seed: 20260813
```

Set the environment variable before starting Pi. Its value may point outside the project and is
never copied into tool results, the session ledger, run evidence, or the research log:

```bash
export VEIL_PRICES_ROOT=/private/path/to/csv-directory
pi
```

For data beside the adapter, set `root: .` and `root_env: null`. For a narrower data directory beneath
the project, use `root: relative/directory`. Exactly one of `root` and `root_env` must be selected.
The default profile supports CSV and Parquet through the file backend; custom backends use the
exported project-loader interface rather than adding SQL or DSNs to the tool schema.

Generated `.veil/views/`, `.veil/runs/`, and `.veil/research-log.md` may reveal research identities
or notes even though they contain no source path. Add them to your project's ignore policy when they
should remain local. Keep `.veil/project.yaml` and promotion requests only if their declarations are
safe to share.

## 4. Start from a brief

Inside Pi, invoke the packaged prompt template:

```text
/veil-research-plan Test whether 20-session cross-sectional momentum survives a one-session execution lag.
```

Before the agent starts, Veil automatically writes the first brief and hypothesis to the active Pi
session branch. Pi supplies the durable entry id and timestamp; a timestamp typed into a tool
argument is not accepted as chronology evidence. Inspect the state at any time by asking the agent to
call:

```json
{ "action": "status" }
```

on `veil-memory`. For a stricter, more specific registration, use:

```text
/veil-hypothesis momentum-20-v1 :: Past 20-session winners outperform losers after a one-session lag.
```

A material change needs a new reference. Forking a Pi session inherits only entries on the selected
ancestor branch, so sibling research does not silently count as preregistration.

## 5. Read and explore

Ask the agent to call `veil-data` with an explicit cutoff:

```json
{
  "dataset": "my-prices",
  "mode": "panel",
  "as_of": "2026-08-12T00:00:00.000Z",
  "columns": ["ticker", "date", "close", "volume"],
  "output": "arrow"
}
```

`output: "arrow"` explicitly creates `.veil/views/<read-set-id>.arrow`; `output: "summary"` has no
file side effect. Both modes pass through the mandatory temporal guard. A panel remains
`exploration-grade`; a point read is `guarded`, which still does not mean that a performance claim is
verified.

Now explore normally. Pi can read files, write scripts, and run your preferred analysis. Veil does
not block those tools. If a result resembles full-sample fitting, a future function, or a current
constituent universe, the extension appends an advisory. Advisories are heuristics and never change
tool success. Label every exploratory metric `unverified`.

## 6. Package one factor

The built-in `veil-node` runner calls a deterministic module as `compute(table, context)`. `table` is
the guarded Arrow table for exactly one train cutoff or OOS decision. `context` contains the locked
parameters, declared literals, dataset identity, decision time, and content hashes—no source binding,
path, credential, or future block. The exact immutable maps are `context.paramsLocked` and
`context.declaredLiterals`.

The callable may return Arrow IPC bytes, an Arrow `Table`, or a dependency-free row selection plus
derived columns:

```js
// factor/factor.mjs
export function compute(table, context) {
  const close = table.getChild("close");
  if (close === null) throw new Error("close is missing");

  const rowIndices = Array.from({ length: table.numRows }, (_, row) => row);
  return {
    rowIndices,
    columns: {
      signal: rowIndices.map((row) => Number(close.get(row))),
    },
  };
}
```

The runner preserves source columns for the selected rows and adds the declared derived columns.
The parent process independently rejects output that reintroduces an entity/event pair absent from
the mask-first input or presents historical rows as the current OOS signal.

`rowIndices` must remain strictly increasing in source-table order. When a source row has no signal,
prefer a `null` derived value over regrouping or reordering the source rows.

## 7. Prepare and promote

Copy the complete request shape from
[`packages/veil-agent/skills/research-loop/assets/promotion-request.yaml`](../packages/veil-agent/skills/research-loop/assets/promotion-request.yaml)
to `.veil/promotion.yaml`, then replace every placeholder. Important fields are:

- `hypothesis_ref`: a reference visible in `veil-memory status`;
- `development_read_sets`: ids actually returned by `veil-data` on this active branch;
- `factor.code_root` and `factor.files`: explicit project-relative code membership;
- `params_locked`, `declared_literals`, and `trials_declared`: the exact searched artifact identity;
- `decision_schedule`: unique ordered sessions, not a guessed calendar;
- `protocol`: rolling/expanding folds with purge, embargo, holding, and execution-lag semantics;
- `cost_model`: a portable logical provider id, never a filesystem path or locator URI;
- `stage4`: the locked pricing columns, long-only or long/short portfolio kind, equal or positive
  trailing-information sizing, capacity assumptions, null method, trial budget, and model knowledge
  cutoff. Omit the entire block only when you intentionally want a structural candidate.

A promotion request names exactly one registered dataset. Every `development_read_sets` id must come
from a `veil-data` call for that same dataset. Other datasets may inform exploration, but they are
not listed in this request; until a composite source is registered before the session, the resulting
candidate covers only the selected structural slice and does not verify a multi-source metric. Never
change adapter guarantees merely to make promotion pass.

If the selected dataset has no truthful declared tradability mask, choose another already registered
dataset for the structural slice or keep the result exploratory. Do not add a mask guarantee without
source evidence.

The schedule length is exact:
`train_days + purge_days + embargo_days + folds * oos_days`. Every `*days` value counts schedule
entries, not calendar days. The standard Stage 4 stability and significance gates require at least
three OOS folds and 30 OOS observations. Start with the smallest topology that satisfies the actual
research protocol; each train cutoff and OOS decision executes the artifact once.

Apply a structured remedy only when it preserves the registered inputs and the research brief. If a
brief-specified protocol or an existing dataset guarantee intrinsically conflicts with C1-C4, keep
the rejection and report the result as invalid or exploratory instead of silently changing the
research question. A successful promotion—or a terminal truthful rejection—ends this loop;
record the evidence and limitations once, then stop rather than manually replaying the artifact.

Before promotion, compare the local calculation with the request field by field: universe, signal
time, entry time, holding period, rebalance cadence, return convention, masks, and costs. A candidate
verifies only that exact request; it does not validate a local metric computed under different
timing. An exploratory Sharpe or return cannot support an allocation recommendation even when the
structural candidate succeeds. Only an accepted Experiment can verify its own exact metric.

Then run:

```text
/veil-promote .veil/promotion.yaml
```

After parsing the strict request and resolving its registered dataset, `veil-backtest` appends a
durable verification-start entry before semantic preflight or engine work. It rejects known
point-in-time or survivorship degradation, recaptures the code, creates the content-addressed
artifact, performs a fresh guarded read and framed child execution at every train/OOS decision,
verifies C1-C4, and applies C6 chronology. A missing or late matching registration remains explicitly
`exploratory`; a damaged registration or structural contract violation is rejected with a stable
code and remedy.

A structural-only success looks like this shape:

```json
{
  "ok": true,
  "status": "awaiting-pricing-and-gates",
  "structuralStatus": "contract-verified",
  "claimStatus": "unverified",
  "registrationStatus": "preregistered",
  "candidateHash": "sha256:...",
  "requiredEvidence": ["pricing", "costs", "statistical-gates"]
}
```

With a complete Stage 4 block, success instead has `status: "complete"`, an `experimentId`,
`verdict: "accepted"`, `claimStatus: "verified"`, net OOS metrics, and one reason record per gate.
Degraded and rejected complete Experiments are archived too; never hide them or call them verified.

The full portable C1-C6 evidence is written once under `.veil/runs/`. Complete Stage 4 archives live
under `.veil/experiments/`, while exact guarded inputs live under `.veil/snapshots/`. The Pi branch and
`.veil/research-log.md` receive compact append-only Experiment memory without the private data root.

Use `/veil-reproduce <experimentId>` for metric-level reproduction. Veil materializes the archived
artifact, replays the exact snapshots, reprices it, reruns every gate, and requires the Experiment,
metric, pricing, and gate identities to match. Missing retained data fails with
`READ_SET_UNAVAILABLE`; current data is never substituted.

## Cold reference and 30-minute trial

From a source checkout, run the model-free reference loop:

```bash
npm run agent-loop:verify
npm run stage4-agent:verify
```

It uses an isolated temporary project and emits path-free JSON. For the external usability trial,
use a person who did not implement this feature and a real private CSV:

- [ ] Record the Veil version/commit, OS, architecture, Node, npm, and Pi versions.
- [ ] Install `veil-quant` without editing its source.
- [ ] Create one adapter and `.veil/project.yaml` without embedding a private root or credential.
- [ ] Reach one successful `veil-data` read and explain every reported degradation.
- [ ] Register a specific hypothesis and package one deterministic factor.
- [ ] Run `/veil-promote`. Reach a candidate only with genuinely point-in-time, survivorship-safe
      data; otherwise preserve and explain the expected C1 rejection. With Stage 4 configured, explain
      every gate outcome and reproduce any resulting Experiment by id.
- [ ] Confirm tool output, session entries, run evidence, and the log contain no private root.
- [ ] Finish within 30 minutes, or preserve the exact blocked step and public error.

Record only metadata, never the CSV, paths, credentials, environment values, or source rows:

```text
Veil version / commit:
OS / architecture:
Node / npm / Pi:
Approximate CSV shape:
Minutes to first guarded read:
Minutes to promotion candidate / Experiment:
Unexpected public code and remedy:
First unclear documentation step:
Did any output expose a root or secret? yes/no
Could the user explain candidate vs Experiment? yes/no
Outcome: pass / blocked
```

An external pass measures usability; it does not replace contract tests. Preserve blocked outcomes
and fix the instruction or diagnostic that caused them.
