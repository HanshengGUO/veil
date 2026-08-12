# Artifacts

An artifact is the immutable unit that crosses from free exploration into verification:
`compute(data_view)`, its explicit code files, locked parameters, declared data-derived literals,
and the data semantics and protocol it expects. Changing any identity-bearing input creates a
different artifact; a mutable working-tree path is never evidence of identity.

Status: `veil.artifact.v0` identity and runtime-provider-neutral framed subprocess execution are
implemented. Walk-forward window orchestration and C2/C3/C4 enforcement begin in Stage 2C-3. See
the exact normalized artifact shape in
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

## Execute one guarded window

Runtime providers are injected capabilities. The artifact names a logical runtime and portable
constraint; a registry selects a trusted provider with a concrete, path-free implementation
identity. The provider's executable, argv, and environment remain private runtime state.

```ts
const runtimes = new ArtifactRuntimeRegistry();
runtimes.register(createArtifactRuntimeProvider({
  id: "python",
  implementation: { name: "cpython", version: "3.12.7" },
  supports: (constraint) => constraint === ">=3.11,<4",
  launch: () => ({
    executable: absolutePythonPath,
    arguments: [absoluteRunnerPath],
  }),
}));

const executed = await executeArtifact({
  artifact,
  codeRoot: "/absolute/project/factor",
  readSet: verificationView.readSet,
  arrowIpc: verificationView.arrowIpc,
  runtimes,
  limits: { timeoutMs: 60_000 },
});
```

Before launch, the engine independently verifies the artifact, guarded read-set, exact Arrow hash,
dataset declaration, and code tree. Development read-sets cannot be reused as verification inputs.
It copies only declared code files into a fresh temporary root, re-hashes the copy before and after
provider preparation, and executes that copy with an absolute executable and `shell: false`. The
developer environment is not inherited; common credential- and developer-path-bearing provider
variables are rejected.

Stdin contains one versioned frame: fixed magic, bounded canonical-JSON control, and exact guarded
Arrow. The request hash binds the artifact, code tree, concrete runtime identity, entrypoint,
dataset, read-set, decision time, immutable parameters/literals, and input Arrow hash. Stdout may
contain exactly one identity-bound result frame with readable Arrow. Partial, malformed, duplicate,
unknown, non-canonical, oversized, or trailing output fails closed. Stderr is a separately counted
diagnostic channel and is never copied into public results or errors. Timeouts, cancellation,
signals, non-zero exits, and stdout/stderr floods have structured sanitized errors.

The codec is public so a thin Python, Rust, or other language adapter can implement the same wire
contract. The engine itself has no language or database switch. Run
`npm run artifact-execution:verify` for the clean Node adapter example.

## Three identities, three jobs

| Identity | Contains | Changes when |
| --- | --- | --- |
| Artifact | Code tree, runtime/entrypoint, locked choices, adapter hashes, development evidence, declared protocol | The promoted object or its declared provenance changes |
| Window read-set | Exact source/query/guarded Arrow delivered for one decision-time window | A verification window reads different evidence |
| Experiment | Artifact plus all window executions, metrics, gates, and verdict | A verification run or outcome changes |

Each dataset's `developmentReadSets` records which exploration evidence led to promotion. These are
not reusable as execution windows and do not authorize a current source query. Every framed request
is instead bound to a newly guarded read-set id. Stage 2C-3 will aggregate those window executions
into a deterministic experiment record without changing the artifact identity.

## The verification boundary

Veil, not factor code, owns source bindings, backend handles, credentials, and decision-time reads.
The implemented single-window boundary:

1. constructs the point-in-time view through the same backend-neutral temporal guard used by
   `veil-data`;
2. passes only guarded Arrow IPC and immutable run metadata to the artifact subprocess;
3. validates framing, identities, limits, and Arrow output before returning it.

The Stage 2C-3/4 orchestrator will construct rolling/expanding windows, apply the declared
tradability mask before signal formation, and admit validated outputs to an experiment record.

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

Framed execution proves one child ran against one exact guarded input; it does not by itself make an
artifact verified. Until WFA and C2/C3/C4 checks exist, exploration metrics remain uncitable.
