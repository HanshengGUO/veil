# Examples

| Example | What it is |
| --- | --- |
| [`csv-pit/`](./csv-pit) | The smallest adapter → guarded CSV point-in-time read. |
| [`parquet-pit/`](./parquet-pit) | The same guarded contract over generated Parquet. |
| [`multi-file-pit/`](./multi-file-pit) | Two CSV members → one stable, path-free source manifest and guarded view. |
| [`read-set/`](./read-set) | Atomic content-addressed snapshot publication and independent-process replay. |
| [`snapshot-recovery/`](./snapshot-recovery) | Detect, quarantine, audit, and explicitly republish corrupt snapshot evidence. |
| [`veil-data/`](./veil-data) | Cold point Arrow and exploration-grade panel snapshot through the backend-neutral CLI core. |
| [`own-data/`](./own-data) | Checkout-local launcher for inspecting a private CSV/Parquet source without editing Veil code. |
| [`artifact-identity/`](./artifact-identity) | Explicit Python code tree → path-independent artifact identity → cold verification. |
| [`artifact-execution/`](./artifact-execution) | Guarded Arrow → bounded framed child → identity-bound result. |
| [`walk-forward-windows/`](./walk-forward-windows) | Explicit schedule → replayable training windows → deterministic executed record. |
| [`walk-forward-contract/`](./walk-forward-contract) | Fresh per-decision PIT reads → mask-first child inputs → C1-C4 contract → unverified promotion candidate. |
| [`agent-loop/`](./agent-loop) | Default structural-only Pi tool path and append-only research log. |
| [`stage4-plugin/`](./stage4-plugin) | Public CostModel and NullGenerator contribution template plus conformance execution. |
| [`stage4-claim/`](./stage4-claim) | Deterministic pricing → full gate policy → citable Experiment → metric reproduction. |
| [`stage4-agent-loop/`](./stage4-agent-loop) | Default agent promotion → Experiment memory → archived read-set reproduction. |
| [`golden-path/`](./golden-path) | An independent hand-written reference plus the real guard → composite evidence → artifact → contract → unverified-candidate acceptance path. |

The golden path is the standard answer for the whole project. Its pricing implementation stays
independent from the engine evidence harness, Stage 3 asks an agent to reproduce it, and its
synthetic market seeds several bench tasks. Start with its
[research log](./golden-path/README.md) — it doubles as the template every Veil research log follows.
