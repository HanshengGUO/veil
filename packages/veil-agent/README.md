# veil-quant

The package users install. A [Pi](https://github.com/badlogic/pi-mono) package bundling Veil's
extensions, skills, and prompt templates:

```bash
pi install npm:veil-quant   # available from v0.1 (Stage 3)
```

Status: Stage 0 — skeleton. Published from `packages/veil-agent` under the unscoped name
`veil-quant`; the libraries it builds on are `@veilquant/contract` and `@veilquant/engine`.

## What lands here, and when

| Component | Stage | Pi mechanism |
| --- | --- | --- |
| `veil-data`, `veil-backtest`, `veil-memory` tools | 3 | `pi.registerTool()` |
| Contract interception | 3 | `pi.on("tool_call")` — blocks, patches arguments, fails safe |
| Exploration advisories (warn, never block) | 3 | `pi.on("tool_result")` |
| Hypothesis auto-registration (C6) | 3 | `session_start` + `pi.appendEntry()` |
| Commands: `/veil-brief`, `/veil-promote`, `/veil-reproduce` | 3 | `pi.registerCommand()` |
| Memory retrieval into context | 4 | `before_agent_start` + summary injection |

## Rule

Veil does not fork Pi. If an invariant cannot be enforced from an extension, the design is too
invasive and the fix belongs in `@veilquant/engine`.
