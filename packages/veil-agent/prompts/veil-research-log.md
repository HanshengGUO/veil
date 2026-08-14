---
description: Write an honest log entry for a Veil research run or Experiment
argument-hint: "<researchRunId>"
---
Use `veil-memory get_run` or `get_experiment` for `${1:-the most recent completed result}` and write a
concise Markdown summary. Include the brief, hypothesis, method, adapter semantics, artifact/plan/
contract identities, candidate or Experiment id, gate reasons, limitations, and next action. Clearly
distinguish exploratory observations from engine evidence. Call a structural-only candidate
“contract-verified, unverified.” Cite a metric only when the record itself issued it; qualify degraded
or rejected Experiments and never turn a differently timed local number into a recommendation.
