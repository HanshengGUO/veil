# Concepts

Seven terms. Once these are clear, the rest of Veil is mechanical.

## Exploration surface

Your normal workflow. An agent reads data, writes code, runs its own backtest, iterates. Veil never
blocks anything here, and it never will — a harness that interrupts exploration would cost more than
the errors it prevents, and would be abandoned within a week.

What Veil does instead is make the safe path the default one: data arrives as a point-in-time view
with a tradability mask attached, and when something looks like a leak, you get an advisory. An
advisory is a remark, not a gate.

Everything produced here is **unverified**. That is not a criticism; it is the state of the number.

## Verification surface

What you cross to make a claim. The factor is repackaged as an artifact and re-executed, one
walk-forward window at a time. Inside each window, rows you could not have known at that moment are
not filtered out — they are absent. There is no code path that reaches them.

This is why leakage is structural here rather than a matter of review: whole-sample statistics cannot
be computed from data that is not present, and a fill cannot use a bar the window does not contain.

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

## Experiment record

What verification issues: metrics, gate outcomes, the artifact hash, the datasets and their declared
guarantees, the registered hypothesis, the verdict, and the reasoning behind it.

It is the only citable metric in the system. A conclusion referring to a number without an experiment
id is rejected — not degraded, rejected. This single rule is what allows exploration to be free.

## Evaporation

The difference between what exploration claimed and what verification issued.

It is the number to watch, and the one Veil reports back to you: *your factor lost this much Sharpe
when it was checked.* In the reference study it is 7.7 — an honest 0.88 against a naive 8.61. A high
evaporation is not a failure of the tool. It is the tool doing the only job it has.

## Gates

Checks a claim passes before promotion. Two kinds, and the distinction matters:

- **Mechanism** is enforced and not configurable: reads are point-in-time, evaluation is
  walk-forward, trials are counted, promotion faces a placebo comparison. These are the same for
  equities, futures, crypto and satellite imagery, because none of them depend on what the data means.
- **Method** is yours: which statistic prices significance, which generator builds the null, which
  cost model applies. Registered as plugins, per asset class.

When a method is unavailable for your data — no null generator, no cost model — the result is marked
and weakened, not blocked. Degrade, never silently accept.

---

## The one-sentence version

Explore however you like; when you want to call something a result, the system re-runs it under a
protocol you cannot bend, and tells you what was left.
