---
description: Write an honest log entry for a Veil Stage 3 research run
argument-hint: "<researchRunId>"
---
Use `veil-memory get_run` for research run `${1:-the most recent completed run}` and write a concise
Markdown summary. Include the brief, hypothesis reference, method, adapter semantics, artifact hash,
plan hash, contract hash, candidate hash or rejection code, limitations, and next action. Clearly
distinguish exploratory observations from engine evidence. If a candidate exists, call it
“contract-verified, unverified.” Do not add a return, Sharpe ratio, gate verdict, or Experiment id
that the run record did not issue. Do not use the candidate to validate a local metric from a
different protocol or turn an unverified number into an allocation recommendation.
