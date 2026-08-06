# @veilquant/engine

The verification surface. Everything that makes a claim expensive lives here.

Status: Stage 0 — skeleton. This package is `private` until it has a public API (Stage 2).

## What lands here, and when

| Component | Stage | Notes |
| --- | --- | --- |
| Point-in-time view layer | 2 | DuckDB logical views over user files/tables; data stays where it is |
| Read-set snapshots | 2 | What an experiment actually read, content-addressed, for metric-level reproduction |
| Verification engine | 2 | Re-executes an artifact window by window: rows with `available_time > t` do not exist |
| Artifact management | 2 | `compute(data_view)` packaging, parameter locking, content-addressed identity |
| Statistical gates | 4 | Trials-aware deflated Sharpe, parameter stability, null-environment falsification, cost sensitivity |
| Plugin interfaces | 4 | `CostModel`, `NullGenerator` |

## Design constraints

- **The window is the guarantee.** A verification window is built so future rows are absent, not
  merely filtered late. If a leak is possible in principle, it belongs to the window builder, not
  to a downstream check.
- **Data stays put.** The engine builds views over the user's files and tables. The only things it
  writes are read-set snapshots and bench fixtures.
- **User factor code is a subprocess.** Artifacts run in whatever language the user writes them in,
  over Arrow IPC. The engine never embeds a second numerical stack.
