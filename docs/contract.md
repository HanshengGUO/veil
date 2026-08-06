# The Veil Contract, version 1.0

This is the normative specification. It is written before the code that enforces it, and the code
follows it rather than the other way round.

Status: stable from v0.1. The wording may be sharpened; the meaning of C1-C6 will not change inside
1.x. Identifiers (`C1`-`C6`) appear in error messages, audit records, and bench task declarations,
and are part of the public interface.

---

## 1. What the contract is for

Leakage costs nothing while you are exploring. It costs something at exactly two moments: when a
result is **believed**, and when a strategy is **deployed**. Both are claims. So Veil places its
enforcement on claims, not on keystrokes.

This gives two surfaces with different rules:

| | Exploration surface | Verification surface |
| --- | --- | --- |
| What it is | Your normal workflow: an agent writing and running its own code | Re-execution of a packaged artifact, walk-forward, window by window |
| Blocking | **Never.** Advisories only | Yes: a violation raises `ContractViolation` |
| Data shape | Point-in-time views by default, with a tradability mask | Windows constructed so future rows do not exist |
| Output status | `unverified` — cannot enter a conclusion | An experiment record, which is the only citable metric |

The rule that connects them is C5. Everything else exists to make C5 worth obeying.

## 2. Definitions

- **decision time** (`t`): the instant whose information set a computation is allowed to use.
- **`event_time`**: when the thing being described happened.
- **`available_time`**: when the description of it could first be known. The anchor for
  point-in-time correctness. If a dataset cannot supply one, see §5.
- **artifact**: `compute(data_view)` plus locked parameters plus the data semantics it was built
  against, identified by a content hash.
- **experiment record**: what the verification engine issues after re-executing an artifact and
  running the gates. Metrics that are not in an experiment record are not results.
- **claim**: any statement that an effect exists — a conclusion, a memory verdict, a promotion, or a
  deployment.

## 3. The invariants

### C1 — Decision-time information set

> A computation performed for decision time `t` MUST NOT use information whose `available_time`
> is later than `t`.

- Point-in-time reads MUST carry `as_of`. There is no default.
- On the verification surface, this is enforced by construction: a window for decision time `t`
  contains no rows with `available_time > t`. Absence, not filtering.
- Full-sample statistics (means, volatilities, quantiles, fitted scalers) computed over a period
  extending beyond `t` and then applied at `t` are violations, whether or not the code looks wrong.

*Rejects:* whole-sample normalization, same-bar execution, forward-filled revisions, any join whose
right-hand side is keyed only on `event_time`.

### C2 — Walk-forward only

> Verification MUST use rolling or expanding walk-forward evaluation with a purge gap and an
> embargo. Random cross-validation MUST NOT be available.

- The purge gap MUST be at least the label horizon. Where features and labels overlap in time, it
  MUST be at least the overlap.
- The embargo is applied after the purge gap and defaults to a non-zero value.
- Parameters and windows are recorded in the experiment record; changing them produces a new record,
  never an amended one.

*Rejects:* k-fold on time series, test windows abutting training windows, evaluation windows chosen
after seeing results.

### C3 — Parameter lock

> Parameters MUST be locked in-sample and read-only out-of-sample. Changing a parameter produces a
> new artifact and requires a new in-sample window.

- Locked parameters are part of the artifact hash, so a changed parameter cannot masquerade as the
  same artifact.
- Numeric literals inside artifact code are parameters. They MUST be declared
  (`declared_literals`), because a constant carried out of exploration is indistinguishable from a
  fitted one — see §6.

*Rejects:* tuning against out-of-sample results, re-running with a "small adjustment" and keeping the
old record.

### C4 — Tradability mask first

> Instruments that could not be traded at `t` MUST be excluded before signals are formed, not after.

- Views carry the mask declared by the adapter; verification applies it before ranking, weighting, or
  optimizing.
- Users may register additional mask rules. They may not remove the mask.

*Rejects:* signals formed on halted or unlisted instruments and filtered afterwards, which changes
cross-sectional statistics and quantile boundaries.

### C5 — Claims must pass verification

> Any metric entering a conclusion, a memory verdict, a promotion, or a deployment MUST have been
> issued by the verification engine as part of an experiment record.

- Exploration output is labelled `unverified` and stays that way.
- A claim citing no experiment id is rejected, not degraded.
- Data source credentials are held by the engine, not by the agent's shell.

This is the invariant that lets exploration be free. An agent may compute anything it likes; it
simply cannot promote what it computed.

### C6 — Hypothesis pre-registration

> A hypothesis MUST be registered, with a timestamp and its source of information, before the result
> that tests it is verified.

- Registration is automatic: the session's brief and first stated hypothesis are captured and
  timestamped at session start, so the cost to the researcher is zero.
- The record MUST include when the *idea* became available, which is how model-training-period
  contamination is tracked (§6).
- Findings without a prior registration are marked `exploratory` and face a higher promotion bar.
  They are not forbidden.

*Rejects:* hypotheses written after the answer is known, in a form the answer already fits.

## 4. Violations

A violation raises a structured error, never a warning:

```ts
new ContractViolation("C1", "read at 2021-06-01 exposed rows available 2021-06-02", {
  dataset: "prices@v1",
  asOf: "2021-06-01",
  remedy: "pass as_of and re-run",
});
```

Violations are written to the audit log with the invariant id, the dataset, and the decision time.
Bench scores them as structural (G1) catches.

Enforcement fails safe: if a validator itself errors, the operation is blocked.

## 5. Guarantee declarations and degradation

Not every dataset can support every invariant, and refusing such datasets would make Veil useless
for alternative data. Adapters therefore declare capabilities, and the harness decides which gates
apply and which conclusions are degraded.

| Declaration | If absent or false | Consequence |
| --- | --- | --- |
| `available_time` | `null` | C1 degrades to filtering on `event_time`; the dataset is marked **PIT-unsafe**; every conclusion using it carries the mark and faces a one-step higher significance bar |
| `vintage` | `false` | Restatement-sensitive conclusions (anything fundamentals-based) are degraded and flagged |
| `survivorship_free` | `false` or `unknown` | Universe construction is treated as suspect; results are flagged, and long-biased conclusions degraded |
| `tradability_mask` | `null` | C4 cannot be enforced for this dataset; the omission is recorded on every result derived from it |

The principle is **degrade, never silently accept, and refuse only when refusing is the honest
answer**. A missing null generator, a missing cost model, or a missing mask produces a marked and
weakened result — not a blocked line of research, and not an unmarked strong one.

## 6. Threat model for v1

Veil v1 defends against **carelessness, self-deception, and protocol-induced false discovery**: the
whole-sample normalization nobody noticed, the same-bar fill, the twentieth variant that finally
worked, the hypothesis rewritten after the fact, the brief that asks the agent to prove a
conclusion.

Veil v1 does **not** defend against a deliberately adversarial agent or user:

- The exploration surface has no mount isolation. Pi ships no sandbox by design, and Veil does not
  build one in v1. An agent can read raw files directly. What it cannot do is turn that into a
  verified claim.
- `tool_call` interception cannot statically determine what a shell command will access. Path
  allowlisting is best-effort auditing, not containment.
- **Constant smuggling** has no static defence: statistics computed during exploration can be
  hardcoded as literals in an artifact, and re-execution cannot tell where a number came from.
  Mitigations are declaration (`declared_literals`), the parameter lock, parameter-stability
  requirements, and null-environment falsification.
- **Training-data contamination** cannot be eliminated. If the research period lies inside a model's
  training window, the model may have seen the answer. Veil records when each hypothesis became
  available and flags conclusions in that window for post-cutoff checking.

Hardening beyond this — container isolation, an append-only hash-chained ledger — is a Stage 6
profile, enabled explicitly, for adversarial settings.

## 7. What the contract does not do

It does not review your code, judge your ideas, or restrict what data you may study. It constrains
one thing: what may be called a result.
