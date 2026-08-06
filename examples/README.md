# Examples

| Example | What it is |
| --- | --- |
| [`golden-path/`](./golden-path) | The reference research run, written by hand. One factor evaluated under an honest protocol and under seven variations, each leaking in exactly one way. |

The golden path is the standard answer for the whole project: Stage 2 re-runs it on the engine,
Stage 3 asks an agent to reproduce it, and its synthetic market seeds several bench tasks. Start
with its [research log](./golden-path/README.md) — it doubles as the template every Veil research
log follows.
