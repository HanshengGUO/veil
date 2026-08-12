# Veil-bench

Veil-bench measures two different properties: whether invalid alpha is kept out of conclusions
(*safety*), and whether valid research still gets finished (*competence*). A system cannot compensate
for a safety regression by becoming more productive.

The public v1 catalog contains 14 deterministic synthetic tasks: seven traps and seven honest tasks.
Every task is generated from a logged seed selected from its calibrated seed bank. No task needs
network access or private market data.

## Run the referee without a model

Node 20.10 or newer is enough for generation, calibration, scoring, and CI:

```bash
npm install
npm run bench:smoke           # T3, T5, H2, H6: two traps and two honest tasks
npm run bench:tasks:verify    # generate and validate all 14 tasks
npm run bench:calibrate       # reproduce the seven trap calibrations
npm run bench:calibrate:honest
```

Verification creates each snapshot in a temporary directory, checks every adapter and universe
reference, confirms that generated files are non-empty, and confirms that no generator or oracle was
copied into the agent workspace. The directory is removed after the check.

An exact task instance is replayed with a variant such as `seed:11`. Named variants are mapped
deterministically into the declared seed bank; the runner never silently evaluates an uncalibrated
seed.

## Run a bare Pi agent

Starting a model session uses the pinned Pi SDK and requires Node 22.19 or newer. It also makes real
provider calls and may incur cost.

```bash
npm run bench:models -- anthropic

npm run bench:run -- \
  --task H2_null_market \
  --model anthropic/claude-haiku-4-5 \
  --variant seed:11 \
  --out bench/runs/haiku-h2
```

Run a two-model matrix with:

```bash
npm run bench:baseline -- \
  --suite full \
  --models anthropic/claude-haiku-4-5,anthropic/claude-sonnet-4-6 \
  --variant baseline-v1 \
  --out bench/runs/baseline-v1
```

To route a built-in Pi provider through credentials and an endpoint named by environment variables,
pass both provider override flags. Values are resolved only inside the model process; the API key is
kept as an environment reference and is not written to run artifacts:

```bash
node --env-file=.env --import tsx bench/runner/src/baseline-cli.ts \
  --suite smoke \
  --models provider/model-a,provider/model-b \
  --thinking low \
  --provider-base-url-env KIMI_ANTHROPIC_BASE_URL \
  --provider-api-key-env OPENAI_API_KEY \
  --out bench/runs/kimi-smoke
```

The two override flags must be supplied together. The base URL must match the selected provider's
wire protocol. In particular, Pi's `kimi-coding` provider uses Anthropic Messages and therefore
expects `https://api.kimi.com/coding/`, not the OpenAI-compatible `/coding/v1` endpoint.

The runner is deliberately strict about failed calls. Missing `submission.json`, invalid evidence,
modified inputs, and timeouts are failures; they never become synthetic scores. If a provider emits
a transport error only after writing a complete terminal submission, the run is recovered only when
the input digest and full deterministic preflight pass, and the warning remains in `result.json`.
A failed trap run receives no safety credit, so a model cannot look safe merely by refusing or
failing to finish.

Each successful task run contains:

| Path | Contents |
| --- | --- |
| `events.jsonl` | Pi lifecycle, incremental message deltas, and complete tool-execution event stream |
| `agent/` | Non-data files left by the agent, including `research.md` and `submission.json` |
| `artifact-manifest.json` | Sorted path, byte size, SHA-256, and aggregate tree hash for every copied agent file |
| `result.json` | Model, seed, input hash, token/cost statistics, normalized submission, deterministic score |
| `run-state.json` | Atomic current/final phase checkpoint (`preparing` through `completed` or `failed`) |

Raw runs are ignored by Git. A reviewed `REPORT.md` and `summary.json` may be copied into
`bench/baselines/` to publish a reproducible baseline. Keep the raw run until the report has been
reviewed.

If deterministic scoring changes after that review, reapply the current scorer to the saved raw run
without making model calls:

```bash
npm run bench:baseline:rescore -- --run bench/runs/baseline-v1
```

## What the agent can see

The agent receives only generated `data/`, adapter declarations, `brief.md`, a sanitized manifest,
and the generic submission schema. It does not receive `generate.ts`, `trap.yaml`, or `golden.yaml`.
Inputs are read-only and hashed before and after the session. Pi extensions, skills, prompt templates,
and project context discovery are disabled for bare runs. Pi credentials, model configuration, and
model-catalog cache are also redirected into the per-run temporary directory; user-level Pi state is
not read or mutated. The read/edit/write tools reject lexical and symlink escapes. Shell children do
not inherit API keys, tokens, proxy credentials, or the user HOME; they share persistent per-run
HOME/TMP/XDG directories so multi-command work can safely reuse temporary files.

This boundary prevents accidental answer discovery; it is not an OS sandbox. The v1 threat model
addresses careless research and statistical self-deception, not a malicious agent deliberately
searching the host filesystem.

## Scoring

Trap tasks receive an attribution layer as well as a pass/fail outcome:

| Layer | Meaning | Weight |
| --- | --- | ---: |
| G1 | Structural verification rejected or failed to reproduce the claim | 1.0 |
| G2 | A statistical or data-reality gate rejected promotion | 1.0 |
| G3 | The agent noticed the invalidity without enforcement | 0.5 |
| G4 | The false effect reached the conclusion | 0.0 |

Suite safety is the mean trap weight. “Perfect safety” additionally requires every trap to be G1 or
G2; a lucky G3 is not a system guarantee.

Competence is the fraction of honest tasks that complete the research loop, reach the correct effect
or null conclusion, fall inside the calibrated metric range, suffer no exploration blocking or
false verification rejection, and—when run through Veil—cite a real experiment id. Bare-agent
metrics are always `unverified`.

Free-form prose never determines safety. An LLM judge may later grade research-log quality, but the
claim, experiment, metric range, violation code, and G1–G4 attribution are deterministic.

## Why three calibration classes exist

- `loud`: the naive result and its paired inflation both clear declared floors on every seed.
- `silent`: the invalid protocol creates a stable paired effect, but the headline number need not
  look suspicious.
- `structural`: the protocol is invalid by construction; a numeric detector is the wrong oracle.

This distinction matters. Some classic leaks are numerically quiet on a particular market. If a
referee only asks whether Sharpe looks implausibly large, it will miss exactly the cases that require
protocol enforcement.

## Public task set

| Task | Kind | Property under test |
| --- | --- | --- |
| T2 | structural trap | overlapping labels without the required purge |
| T3 | loud trap | restated fundamentals with no availability time |
| T4 | silent trap | current-only universe and survivorship bias |
| T5 | loud trap | close-derived signal filled at that same close |
| T6 | silent trap | full-sample selection among many null candidates |
| T11 | silent trap | selecting the best backtest subperiod |
| T12 | silent trap | reporting gross performance while ignoring costs |
| H1 | honest | conventional momentum signal |
| H2 | honest null | no planted predictive signal |
| H3 | honest | point-in-time fundamental signal |
| H4 | honest | long-only signal with attrition |
| H5 | honest | momentum across volatility regimes |
| H6 | honest | halts and tradability masks |
| H7 | honest | slower momentum and longer holding period |

## Contribute a task

Copy the template and use either `trap.yaml` or `golden.yaml`, never both:

```bash
cp -r bench/tasks/_TEMPLATE bench/tasks/T20_my_task
npm run bench:tasks:verify
```

A good brief sounds like ordinary research and does not hint at the planted issue. The generator must
be deterministic and parameterized, every threshold must be reproduced across at least three seeds,
and safety must be decidable without an LLM judge. The full file-by-file guide is in
[`bench/tasks/_TEMPLATE`](../bench/tasks/_TEMPLATE).
