# Artifacts

An artifact is the immutable unit that crosses from free exploration into verification:
`compute(data_view)`, its explicit code files, locked parameters, declared data-derived literals,
and the data semantics and protocol it expects. Changing any identity-bearing input creates a
different artifact; a mutable working-tree path is never evidence of identity.

Status: `veil.artifact.v0` code capture, normalization, content identity, and independent
verification are implemented. Framed subprocess execution and walk-forward orchestration begin in
Stage 2C-2 and are not yet a public API. See the exact normalized shape in
[`artifact.yaml`](../packages/veil-contract/schemas/artifact.yaml).

## Build one portable identity

```ts
import {
  captureArtifactCode,
  createArtifactManifest,
  verifyArtifactCode,
  verifyArtifactManifest,
} from "@veilquant/engine";

const code = await captureArtifactCode({
  root: "/absolute/project/factor", // local-only; never serialized or hashed
  files: ["factor.py", "requirements.lock"],
});

const artifact = createArtifactManifest({
  factor: {
    runtime: { id: "python", constraint: ">=3.11,<4" },
    entry: { file: "factor.py", callable: "compute" },
    code,
  },
  paramsLocked: { lookbackDays: 20 },
  declaredLiterals: { selectedThreshold: 1.5 },
  trialsDeclared: 3,
  dataSemantics: {
    datasets: [{
      declaration,
      developmentReadSets: [guarded.readSet.manifestHash],
    }],
  },
  hypothesisRef: "momentum-v1",
  protocol: {
    mode: "expanding",
    folds: 6,
    trainDays: 504,
    oosDays: 63,
    purgeDays: 5,
    embargoDays: 2,
    holdDays: 5,
  },
  costModel: "equities-bps-v1",
});
```

Code membership is explicit: packaging never sweeps a checkout, cache, `.env`, or `node_modules`
implicitly. Every member must be a portable root-relative regular file. Symbolic links, parent
traversal, filesystem roots, case-colliding names, and platform-specific names are refused. The
engine captures the set twice and records byte length, SHA-256 per file, and an aggregate tree hash;
mtimes, creation order, and the absolute root are excluded.

`createArtifactManifest()` sorts keys and dataset references, hashes normalized adapter declarations
itself, verifies the code-tree hash, and deeply freezes the result. Locked parameters and declared
literals accept canonical JSON only. Credential-named fields, inline credentials, absolute runtime
paths, non-finite numbers, negative zero, cyclic values, and class instances fail closed. Unknown
manifest fields are rejected rather than ignored.

Reloaded evidence is checked independently:

```ts
const restored = verifyArtifactManifest(JSON.parse(serialized), {
  expectedArtifactHash,
  dataSemantics: {
    datasets: [{ declaration, developmentReadSets }],
  },
});
await verifyArtifactCode("/another/checkout/factor", restored.factor.code);
```

Run `npm run artifact:verify` to build from a real guarded read-set, copy the same Python files under
a different absolute root and mtimes, reproduce the identity, and verify it in a clean Node process
without a backend or source binding.

## Three identities, three jobs

| Identity | Contains | Changes when |
| --- | --- | --- |
| Artifact | Code tree, runtime/entrypoint, locked choices, adapter hashes, development evidence, declared protocol | The promoted object or its declared provenance changes |
| Window read-set | Exact source/query/guarded Arrow delivered for one decision-time window | A verification window reads different evidence |
| Experiment | Artifact plus all window executions, metrics, gates, and verdict | A verification run or outcome changes |

Each dataset's `developmentReadSets` records which exploration evidence led to promotion. These are
not reused as WFA windows and do not authorize a current source query. Stage 2C-2/3 will attach newly
guarded read-set ids to each child execution, then the experiment record will cite both layers.

## The verification boundary

Veil, not factor code, owns source bindings, backend handles, credentials, and decision-time reads.
For each verification window the engine will:

1. construct the point-in-time view through the same backend-neutral temporal guard used by
   `veil-data`;
2. apply the declared tradability mask before signal formation;
3. pass only guarded Arrow IPC and immutable run metadata to the artifact subprocess;
4. validate the subprocess output before it can contribute to an experiment record.

```text
SourceBinding + TemporalBackend
             |
       TemporalGuard(as_of)
             |
    guarded Arrow + read-set
             |
     artifact subprocess
             |
      validated factor output
```

The subprocess will receive no raw source path, DSN, credential, backend object, or escape hatch to
a current query. A backend may be DuckDB, another database, a service, or an in-memory
implementation; that choice ends at the guard and is absent from both artifact and child protocols.

Until framed execution and WFA checks exist, an artifact is content-identified but not verified, and
its exploration metrics remain uncitable.
