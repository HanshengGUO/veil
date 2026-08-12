# The Veil Contract, version 1.0

This is the normative specification. It is written before the code that enforces it, and the code
follows it rather than the other way round.

Status:

- **Identifiers `C1`-`C6` are stable from v0.1.** They appear in error messages, audit records, and
  bench task declarations, and are part of the public interface.
- **The meaning of C1-C5 is frozen from v0.1** and will not change inside 1.x. Wording may be
  sharpened.
- **C6 and the degradation tiers in §5 are provisional until v1.0.** Statistical gates arrive in
  Stage 4, and both are expected to need adjustment once they exist. Changes during 0.x are recorded
  in the changelog.
- Moving an invariant's enforcement **earlier** — from claim time to read time, say — is a
  strengthening, not a semantic change, and is allowed at any point.

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
- Storage backends may push the temporal predicate down for efficiency, but pushdown is never a
  trust boundary. Every backend returns Arrow IPC through the common temporal guard, which checks and
  removes rows after `t` again before factor code receives the view. The same protection therefore
  applies to files, databases, extracts, and custom adapters without depending on a SQL dialect.
- Full-sample statistics (means, volatilities, quantiles, fitted scalers) computed over a period
  extending beyond `t` and then applied at `t` are violations, whether or not the code looks wrong.
- Having an `available_time` is not the same as being able to trust it. Where it came from MUST be
  declared (`availability_basis`): the fifteen years of history a vendor hands over on the first
  pull were never observed arriving. See §5.

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
- **Data-derived numeric literals inside artifact code are parameters** and MUST be declared
  (`declared_literals`): a constant carried out of exploration is indistinguishable from a fitted one
  (§6). Structural constants — trading days per year, numerical epsilons, and similar — are
  whitelisted and need no declaration. An undeclared literal is treated as a parameter anyway, so it
  is frozen and enters the artifact hash.
  This rule reduces friction; it does not detect anything. Nothing can statically tell where a number
  came from, which is why the real defences against smuggled constants are parameter stability and
  null-environment falsification.
- **Promotion MUST declare how many candidates preceded this one** (`trials_declared`). Choosing the
  best of thirty explored ideas and promoting only that one is a multiple-testing event even though
  twenty-nine of them were never verified.
  The declared count is not taken on trust: the effective trial count is
  `max(declared, observed lower bound)`, where the lower bound is derived from backtest-shaped calls
  in the session log and prior experiments against the same hypothesis family in memory. Under-
  declaring therefore has no effect, and the number is not paperwork — it is the trials parameter of
  the significance test that gates promotion.

*Rejects:* tuning against out-of-sample results, re-running with a "small adjustment" and keeping the
old record.

### C4 — Tradability mask first

> Instruments that could not be traded at `t` MUST be excluded before signals are formed, not after.

- Views carry the mask declared by the adapter; verification applies it before ranking, weighting, or
  optimizing.
- Users may register additional mask rules. They may not remove the mask.
- **Exemption, for research whose subject is the untradable instruments themselves** — halt and
  resumption effects, delisting behaviour, liquidity events. The exemption is explicitly declared,
  applies only to an **operator's default behaviour**, is recorded in the audit log, and marks every
  conclusion derived through it. **C4 itself admits no exemption:** a strategy claiming tradable
  returns is still ranked mask-first. This is the same split used everywhere in Veil — safe defaults
  may be waived with a declaration, invariants may not.

*Rejects:* signals formed on halted or unlisted instruments and filtered afterwards, which changes
cross-sectional statistics and quantile boundaries.

### C5 — Claims must pass verification

> Any metric entering a conclusion, a memory verdict, a promotion, or a deployment MUST have been
> issued by the verification engine as part of an experiment record.

- Exploration output is labelled `unverified` and stays that way.
- A claim citing no experiment id is rejected, not degraded.
- The engine grants the agent **no new** data-source credentials: what the engine holds, it does not
  hand out. Access the user already has in their own environment is theirs, and Veil does not take it
  away — which is why C5 is written about claims rather than about access.

This is the invariant that lets exploration be free. An agent may compute anything it likes; it
simply cannot promote what it computed.

### C6 — Hypothesis pre-registration

> A hypothesis MUST be registered, with a timestamp and its source of information, before the result
> that tests it is verified.

C6 has a hard half and a soft half, and the distinction is stated plainly because pretending
otherwise would make the invariant a ritual.

**Hard — enforced.** The registration entry MUST exist, with a timestamp, before the verification run
that tests it. Ordering is checked against the session log, so it cannot be arranged afterwards. A
verification with no prior registration is marked `exploratory` and faces a higher promotion bar.

**Soft — acknowledged.** Registration is automatic: the session's brief and first stated hypothesis
are captured and timestamped at session start, so the researcher pays nothing. But automatic capture
cannot guarantee the content is *specific*. "Research momentum" is a registration that any subsequent
finding fits, and Veil cannot tell that from a real prediction. Capture therefore aims for the
universe, the holding period, and the predicted direction, and where it falls short, the guard is
weak. Treat a vague registration as evidence of nothing.

- The record MUST include when the *idea* became available, which is how model-training-period
  contamination is tracked (§6).
- Findings without a prior registration are not forbidden, only marked.

*Rejects:* hypotheses written after the answer is known — mechanically, by timestamp. It does not
reject hypotheses written vaguely enough to fit anything; nothing automatic can.

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
| `availability_basis` | `reconstructed` | The availability timestamp is credible but was not witnessed; conclusions drawn from that segment carry the mark and face a one-step higher bar |
| `availability_basis` | `assumed` | Availability was inferred from a chosen lag; treated exactly like `available_time: null` — **PIT-degraded** |
| `vintage` | `false` | Restatement-sensitive conclusions (anything fundamentals-based) are degraded and flagged |
| `survivorship_free` | `false` or `unknown` | Universe construction is treated as suspect; results are flagged, and long-biased conclusions degraded |
| `tradability_mask` | `null` | C4 cannot be enforced for this dataset; the omission is recorded on every result derived from it |
| `provenance.certified` | absent or `false` | Nothing is rejected; the dataset simply gets no credit beyond what `guarantees` claims. Not being certified is a normal state, not a defect |
| C4 operator exemption | declared | Permitted for research whose subject is the untradable instruments; recorded in the audit log, and every conclusion reached through it is marked |

The tiers in this table are provisional until v1.0: "a one-step higher significance bar" is given a
number when the statistical gates exist in Stage 4, not before.

**Why `availability_basis` exists.** You start collecting a feed today and the vendor hands you
fifteen years of history in the first pull. Every row's availability timestamp is *today*. Two exits
present themselves, and both are wrong: treat it literally, and no research before today is
possible; or "fix" it by setting availability to `event_time` plus a guessed lag, and you have
fabricated point-in-time history. The second is the dangerous one, because **nothing in the data
will ever contradict it** — a backfill declared as `observed` looks exactly like a feed you watched
arrive. So the origin is declared per segment, and the usual shape is honest: `reconstructed` for the
backfill, `observed` from the day you started.

The principle is **degrade, never silently accept, and refuse only when refusing is the honest
answer**. A missing null generator, a missing cost model, or a missing mask produces a marked and
weakened result — not a blocked line of research, and not an unmarked strong one.

### Adapter declaration validation

An adapter is a portable semantic declaration, not a connection profile. Registration normalizes
and validates it before any source is opened:

- `dataset`, `version`, `entity_key`, `event_time`, `available_time`, and `source` are required.
- A non-null `available_time` requires `availability_basis`; a null one forbids it. There is no safe
  default for where a timestamp came from.
- Basis segments select rows by `event_time` and are ordered, contiguous `[from, until)` intervals.
  `reconstructed` requires its vendor/publication source; `assumed` requires a positive ISO-8601 lag
  and a rationale.
- `point_in_time: true` with `available_time: null`, and `certified: true` without `lineage_ref`, are
  contradictory declarations and are rejected.
- Unknown fields are errors, not ignored extensions. This turns misspellings into field-addressable
  failures instead of silent weakening.
- The portable `source.locator` contains a relative file locator or logical table name. Runtime
  paths, DSNs, and credentials are supplied separately to the engine and never enter declaration
  hashes, artifacts, logs, or model context.

`observed` is not self-authenticating. For certified data the engine resolves `lineage_ref` and
cross-checks observed rows against the recorded collection boundary. A row claiming an
`available_time` before collection began is rejected at registration; historical rows must instead
be marked `reconstructed` or `assumed`. Uncertified data may still be used, but it never silently
acquires certified semantics.

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
