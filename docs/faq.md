# Frequently asked questions

## Is Veil only a safety layer?

No. Safety is the non-negotiable boundary, but the product is an evidence-first harness for
AI-assisted quant research. It wraps the workflow researchers already use; contracts clarify what
must be produced, independent evidence makes review concrete, memory prevents silent rediscovery,
and reproduction turns a one-off result into reusable work.

One result surprised us: the evaluated contract, independent-review, and bounded-repair workflow
improved the strict official QBench aggregate in all three tested model configurations — Kimi K3 by
4.25 points and DeepSeek V4 Flash and Pro by 3.25 points each. That supports a claim about final
delivery quality, not wall-clock speed or universal benchmark improvement. See the
[reviewed snapshots](../bench/results/) for protocols and limitations.

## Does Veil stop ordinary exploration?

No. Shell commands, notebooks, scripts, and exploratory metrics remain available. Veil labels those
numbers `unverified` and enforces the contract only when a result is promoted as a claim.

## What is the difference between a candidate and an Experiment?

A promotion candidate proves the artifact survived point-in-time, walk-forward, mask-first, and
registration checks. It contains no performance metric. An Experiment additionally replays retained
evidence, prices trades and costs, completes every statistical gate, and carries a content id. Only
an accepted Experiment has `claimStatus: verified`.

## Why was a good-looking run rejected?

Read the gate `reasonCode`. Common causes are doubled costs removing the edge, too few independent
parameter neighbors, trial-budget exhaustion, deflated Sharpe below its trials-aware threshold, or
return concentration in one fold. The rejection is retained so the same failed idea is not silently
rediscovered.

## Can a clean task correctly end without an effect claim?

Yes. A weak planted or real-world signal can look positive while still failing a locked statistical
gate. In that case, citing the rejected Experiment and reporting the unsupported result is competent
research; changing the conclusion to an effect to match a calibration range is not. A positive
conclusion still requires an accepted, verified Experiment and exact metric identity.

## Why is my Experiment degraded rather than verified?

At least one optional method was unavailable—usually capacity, a null generator, or a model
knowledge cutoff. Degraded evidence may be discussed with its qualification, but it does not support
an unqualified positive effect claim.

## Do I have to use the built-in cost model?

No. Implement the typed `CostModelProvider` boundary or start from
[`examples/stage4-plugin`](../examples/stage4-plugin). The model must return one finite,
non-negative NAV-fraction charge per canonical trade. Its implementation and configuration
identities are frozen before OOS execution.

## What does `trials_declared` count?

Every candidate explored in the research family, including candidates not promoted. Veil then takes
the maximum of that declaration and the observable active-session plus same-family memory count.
Under-declaring cannot reduce the effective count.

## Can I rerun an Experiment after data changes?

Yes, if its exact guarded read-set snapshots are retained. `/veil-reproduce <experimentId>` uses the
archived code and snapshots and requires all metric/evidence identities to match. It never substitutes
new data. A retention deletion fails loudly with `READ_SET_UNAVAILABLE`.
Record the operator, reason, and deletion time with `recordProjectReadSetRetentionDeletion()` before
the external retention process removes snapshot bytes.

## Does a content hash prove the data was truthful?

No. A hash proves that identified bytes did not change. Trust still comes from adapter semantics,
the mandatory temporal guard, read-set capture, and the replay chain. Uncertified provenance remains
an explicit degradation.

## Does the knowledge-cutoff gate eliminate model memorization?

No. It requires post-cutoff evidence when the historical sample could have been known to the model,
which is a useful mitigation. It cannot prove where an idea originated.

## Can Veil defend against a deliberately malicious agent?

That is not the v1 threat model. Veil defends against research mistakes and statistical
self-deception at the claim boundary. It does not claim that Pi's ordinary shell is a security
sandbox. See the threat model in [`contract.md`](./contract.md).

## Is the npm release available?

The repository can be installed from source. A registry version is documented as available only
after its tag, cross-platform release smoke, and publication have actually completed.
