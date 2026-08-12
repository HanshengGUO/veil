# Artifacts

An artifact is the immutable unit that crosses from free exploration into verification:
`compute(data_view)`, its explicit code files, locked parameters, declared data-derived literals,
and the data semantics and protocol it expects. Changing any identity-bearing input creates a
different artifact; a mutable working-tree path is never evidence of identity.

Status: `veil.artifact.v0`, runtime-provider-neutral framed subprocess execution, and deterministic
Stage 2C-3 training-window orchestration are implemented. OOS mask-first evaluation and the final
C2/C3/C4 verdict boundary remain Stage 2C-4 work. See the exact normalized artifact shape in
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

## Execute deterministic training windows

The WFA planner does not guess a trading calendar. Supply the exact ordered UTC sessions required by
the artifact protocol; every `*Days` field counts entries in this schedule:

```ts
const run = await executeWalkForwardWindows({
  artifact,
  codeRoot: "/absolute/project/factor",
  decisionSchedule,
  declaration,
  guard,
  binding,
  runtimes,
  columns: ["ticker", "value"],
});
```

The schedule length must be exactly
`trainDays + purgeDays + embargoDays + folds * oosDays`. It must contain unique, strictly increasing
instants. Each fold records rolling or expanding training, purge, embargo, and contiguous OOS
boundaries. Purge must cover the holding horizon and embargo is always non-zero.

For each training cutoff, orchestration creates a new guarded source read-set. It then derives
`veil.window-read-set.v0` by filtering the retained event-time column to the fold's inclusive training
range. The derived identity commits to the source read-set, declaration, plan/fold/range, and exact
Arrow result. `verifyWindowReadSetManifest()` requires the original source manifest and Arrow and
replays that filter; an in-memory slice cannot masquerade under the source id.

Only derived training Arrow reaches the child. Successful folds issue deterministic `executed`
records, and a complete run issues `veil.walk-forward-run.v0`. Empty windows fail before launch and
any child failure prevents a run record. Run identity excludes backend details, SQL, bindings,
temporary roots, stderr, duration, and completion timing. The injected guard can therefore sit over
DuckDB, another database, a service, or an in-memory backend without changing orchestration.

Run `npm run walk-forward:verify` for a cold custom-backend example. This boundary does not execute
or price OOS rows yet and deliberately does not emit metrics or a `verified` status; those checks
land with mask-first C2/C3/C4 enforcement in Stage 2C-4.

## Four identities, four jobs

| Identity | Contains | Changes when |
| --- | --- | --- |
| Artifact | Code tree, runtime/entrypoint, locked choices, adapter hashes, development evidence, declared protocol | The promoted object or its declared provenance changes |
| Window read-set | Source read identity plus exact plan/fold/range and derived Arrow | A training window reads or derives different evidence |
| Executed run | Plan plus every successful training-window execution identity | A schedule, runtime, input, output, or execution changes |
| Experiment | Artifact plus all window executions, metrics, gates, and verdict | A verification run or outcome changes |

Each dataset's `developmentReadSets` records which exploration evidence led to promotion. These are
not reusable as execution windows and do not authorize a current source query. Every framed request
is instead bound to a newly guarded and derived window id. Stage 2C-3 aggregates successful training
executions into a deterministic run record without changing the artifact identity. That run record
is not the final experiment: it has no OOS metrics, gates, or verdict.

## The verification boundary

Veil, not factor code, owns source bindings, backend handles, credentials, schedules, and
decision-time reads. The implemented boundary:

1. derives deterministic rolling/expanding boundaries from an explicit UTC session schedule;
2. constructs a fresh point-in-time source view at each training cutoff through the same
   backend-neutral temporal guard used by `veil-data`;
3. replays an event-time lower/upper-bound filter into separately identified derived evidence;
4. passes only that Arrow IPC and immutable run metadata to the artifact subprocess;
5. validates framing and identities and issues a run record only after every fold succeeds.

Stage 2C-4 will apply the declared tradability mask before OOS signal formation and admit only those
validated, priced outputs to an experiment record.

```text
SourceBinding + TemporalBackend
             |
    WFA plan → TemporalGuard(train cutoff)
             |
 source read-set → derived train window
             |
     artifact subprocess
             |
 deterministic executed record
```

The subprocess will receive no raw source path, DSN, credential, backend object, or escape hatch to
a current query. A backend may be DuckDB, another database, a service, or an in-memory
implementation; that choice ends at the guard and is absent from both artifact and child protocols.

Framed execution proves one child ran against one exact guarded input. A 2C-3 run proves every
declared training fold executed against replayable evidence. Neither makes an artifact or metric
verified; until 2C-4 OOS C2/C3/C4 enforcement exists, all metrics remain uncitable.
