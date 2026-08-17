# Concepts

Veil is built around a productive idea: safety and research quality do not have to be opposing
forces. Free exploration keeps the search space open; contracts, evidence, reviewable handoffs, and
reproduction help an agent turn the work worth keeping into a stronger final delivery.

Eight terms make that delivery path concrete. Once they are clear, the rest of Veil is mechanical.

## Exploration surface

Your normal workflow. An agent reads data, writes code, runs its own backtest, iterates. Veil never
blocks anything here, and it never will — a harness that interrupts exploration would cost more than
the errors it prevents, and would be abandoned within a week.

What Veil does instead is make the safe path the default one: `veil-data` provides a point-in-time
view with a tradability mask attached, and when tool output looks like a leak, you get an advisory.
An advisory is a remark, not a gate. Ordinary Pi file and shell tools remain available.

Everything produced here is **unverified**. That is not a criticism; it is the state of the number.

## Verification surface

What you cross to make a claim. `veil-backtest` repackages the factor as an artifact and re-executes
it, one walk-forward decision at a time. Inside each decision, rows you could not have known at that
moment are absent before the child starts.

This is why leakage is structural here rather than a matter of review: whole-sample statistics cannot
be computed from data that is not present, and a signal cannot use a bar the window does not contain.
The structural surface feeds Stage 4 pricing, trial accounting, statistical gates, and archival.

## Artifact

The thing that crosses the boundary: `compute(data_view)`, plus locked parameters, plus the data
semantics it was built against, identified by a content hash.

Two consequences worth knowing:

- Changing a parameter produces a different hash, so it is a different artifact. Tuning after seeing
  out-of-sample results cannot be disguised.
- The same object is what a production system loads. Research and production cannot drift apart into
  two implementations, because there is only one.

Packaging is not ceremony: turning exploration code into `compute(data_view)` is work you would do
anyway before deploying anything.

## Promotion candidate

The structural handoff after an artifact completes every PIT, mask-first walk-forward decision and
its hypothesis chronology is checked. It is an input to later pricing and gates, not a result.
Its claim status remains `unverified`, and a candidate hash cannot be cited as an experiment id.
The hash also binds that run's verification-start entry, so a structural rerun compares artifact,
plan, and contract hashes while independently replay-verifying the newly issued candidate.

## Research run

The append-only ledger entry around one promotion attempt. It has a durable Pi session start entry,
a `researchRunId`, and either a structured rejection or a replay-verified candidate. A complete
Stage 4 request then appends a separate Experiment memory entry. The active Pi branch defines the
run's ancestry.

A structural research run is not an Experiment. Its Markdown log is an audit aid, not a source of
citable performance.

## Experiment record

What the Stage 4 claim pipeline issues after structural verification, pricing, costs, and statistical
gates: metrics, gate outcomes, the artifact hash, datasets and declared guarantees, the registered
hypothesis, verdict, and reasoning.

It is the only citable metric in the system. A conclusion referring to a performance number without
an experiment id is
rejected—not degraded. This single rule is what allows exploration to be free.

## Evaporation

The difference between what exploration claimed and what verification issued.

It is the number to watch after Stage 4 pricing: *your factor lost this much Sharpe when
it was checked.* In the hand-written reference study it is 7.7—an honest 0.88 against a naive 8.61.
Stage 3 candidates do not report evaporation because they contain no performance metric.

## Gates

Checks applied to a structurally promoted candidate before its Experiment receives a verdict. Two kinds, and the
distinction matters:

- **Mechanism** is enforced and not configurable: reads are point-in-time, evaluation is
  walk-forward, and trials feed the statistical price. These are the same for equities, futures,
  crypto and satellite imagery because none of them depend on what the data means.
- **Method** is yours: which statistic prices significance, which generator builds the null, which
  cost model applies. Registered as plugins, per asset class.

When an optional Stage 4 method is unavailable—such as capacity data or a null generator—the result
is explicitly degraded, not silently accepted. Missing required cost or stability evidence rejects
the Experiment.

---

## The one-sentence version

Explore however you like; when a result is worth keeping, Veil turns it into a reviewable,
reproducible Experiment through a protocol you cannot quietly bend — protecting the claim while
improving the quality of what you deliver.
