# Security

## Reporting

Use GitHub's private vulnerability reporting on this repository's **Security** tab
("Report a vulnerability"). Please do not open a public issue for something exploitable.

Veil is pre-release: there are no supported released versions yet, and fixes land on the default
branch.

## Scope

[`docs/contract.md`](./docs/contract.md) section 6 states what v1 defends against, and the boundary
matters for triage:

**In scope** — anything that lets a *verified claim* be produced from information that was not
available at the decision time it claims. For example:

- a verification window that exposes rows with `available_time` later than the window's decision time
- a path that issues an experiment record without the gates having run
- an artifact whose recorded parameters or data semantics differ from the ones actually executed
- a way to alter or forge an experiment record that a conclusion then cites
- credential or data exposure from the engine process into the agent's environment

**Not in scope** — the exploration surface is deliberately unconstrained. Veil v1 defends against
carelessness and self-deception, not against a deliberately adversarial agent or operator. So the
following are known and documented, not vulnerabilities:

- an agent reading raw data files directly instead of going through a view
- shell commands that escape path allowlisting, which is best-effort auditing rather than containment
- constant smuggling: statistics computed during exploration and hardcoded into an artifact
- training-data contamination in the model itself

If one of these can be turned into a **verified** claim, that is in scope, and it is exactly the kind
of report we want.

## What happens next

Confirmed findings become bench tasks before they become fixes — a leak that is only patched can come
back, while a leak with a test cannot. With your permission you will be credited in the task and the
changelog.
