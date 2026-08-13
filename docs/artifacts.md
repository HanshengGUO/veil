# Artifacts

An artifact is the immutable unit that crosses from free exploration into verification:
`compute(data_view)`, its explicit code files, locked parameters, declared data-derived literals,
and the data semantics and protocol it expects. Changing any identity-bearing input creates a
different artifact; a mutable working-tree path is never evidence of identity.

Status: `veil.artifact.v0`, runtime-provider-neutral framed subprocess execution, deterministic
training-window orchestration, and per-decision mask-first C1-C4 contract verification are
implemented. The resulting contract record is structural evidence, not a priced Experiment. See
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
    executionLagDays: 1,
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
boundaries. Purge must cover the holding horizon, embargo is always non-zero, and
`executionLagDays` must be at least one explicit session. These timing failures are structured C1/C2
violations with actionable remedies, before data I/O or child launch.

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

Run `npm run walk-forward:verify` for a cold custom-backend example. This frozen training-only
surface deliberately remains `executed`; the complete mask-first contract path is separate.

## Compose guarded sources without trusting a database join

A factor may need obligations from more than one source even though the contract executor currently
accepts one dataset. The golden path, for example, needs both price tradability and point-in-time
universe membership. `createCompositeSource()` resolves that case before artifact execution:

```ts
const composite = createCompositeSource({
  primary: { declaration: prices, readSet: priceRead.readSet, arrowIpc: priceRead.arrowIpc },
  membership: {
    declaration: universe,
    readSet: universeRead.readSet,
    arrowIpc: universeRead.arrowIpc,
  },
  outputDeclaration: researchPanel,
  membershipColumn: "in_universe",
  outputAvailableTimeColumn: "eligible_at",
  outputMembershipColumn: "in_universe",
  outputMaskColumn: "eligible",
});
```

Both inputs must already be `TemporalGuard` read sets at the same `as_of`. The transform performs an
exact entity/event join, rejects duplicate or uncovered primary keys, and requires strict boolean
tradability and membership. It retains every primary row, sets `eligible_at` to the later component
availability, and computes `eligible = tradable && in_universe`. No SQL, connection, or backend
handle enters this step.

`veil.composite-source-manifest.v0` binds both declarations, guarded read-set ids, Arrow/result
identities, the versioned join rule, row audit, and output identity. `verifyCompositeSource()`
replays the join from both Arrow inputs. `CompositeSourceBackend` then serves the materialized result
through an ordinary `TemporalBackend`; callers must put it behind a new `TemporalGuard` for each
decision. Its `SourceFingerprint.evidence` carries the composite manifest, while
`SourceFingerprint.manifest` remains reserved for physical file membership.

## Verify every train and OOS decision

`executeWalkForwardContract()` enforces C1-C4 without adding a database-specific query language or
changing the child frame:

```ts
const checked = await executeWalkForwardContract({
  artifact,
  codeRoot: "/absolute/project/factor",
  decisionSchedule,
  declaration,
  guard,
  binding,
  runtimes,
  columns: ["ticker", "value"],
  // Useful for large independent decisions; record order is still the declared order.
  concurrency: 4,
  // Release intermediate Arrow after its identities and execution record are fixed.
  retainExecutionEvidence: false,
});

verifyWalkForwardContractRecord(checked.record, {
  artifact,
  plan: checked.plan,
  declaration,
  expectedHash: checked.record.contractHash,
});
```

The declaration must name a tradability mask before any source I/O occurs. For each fold, the engine
runs one training cutoff and every OOS decision separately. Each invocation obtains a fresh guarded
read at that exact `as_of`, derives `veil.verification-view.v0` from the fold's training start through
the current decision, requires a strict boolean mask, and removes false rows before the child can
form a signal. The child receives neither the full future OOS block nor the rows removed by the mask.

Child output must retain entity and event-time keys. Every output pair must exist in the masked
input; a child cannot reintroduce a halted entity, duplicate masked evidence, or emit a future row.
For OOS runs, the parent admits only output at the current decision time, so echoed history cannot
masquerade as a current signal. Locked parameters and declared data-derived literals are bound to one
`veil.parameter-lock.v0` identity repeated across every execution.

Invalid WFA topology or an incomplete fold raises C2, parameter identity drift raises C3, and a
missing, malformed, late-applied, or reintroduced mask raises C4. Future output remains a C1
violation. No partial failure returns a contract record.

Concurrency is bounded to 1-32 and defaults to 1. It changes neither the schedule nor content
identity. `retainExecutionEvidence: false` is a memory policy for large runs: `executionCount` and
the complete contract record remain available, while the returned `executions` array is empty and
`executionEvidence` is `discarded`. It does not skip a read, view, child invocation, admission check,
or record; use the default when the caller needs every intermediate Arrow payload after completion.

After all decisions succeed, the engine issues `veil.walk-forward-contract.v0` with status
`contract-verified`. That wording is intentionally narrow: the record contains no pricing, costs,
returns, metrics, gates, or experiment verdict, so it does not satisfy C5 and cannot make a number
citable. Run `npm run walk-forward-contract:verify` for the cold custom-backend probe.
The full 370,728-row golden-path structural acceptance is
`npm run golden-path:evidence:verify`; reference pricing remains a separate implementation.

## Prepare promotion evidence without making a claim

The next boundary accepts only the complete contract record. It cannot ingest a child result, an
exploration backtest, the legacy training-only run, or a free-form metric:

```ts
const registration = createHypothesisRegistration({
  hypothesisRef: artifact.hypothesisRef,
  statement: "Winners outperform cross-sectionally after costs.",
  ideaAvailableAt: "2025-01-01T00:00:00.000Z",
  registeredAt: "2026-08-12T09:00:00.000Z",
  source: { kind: "brief", reference: "session-entry-001" },
});

const candidate = createPromotionCandidate({
  artifact,
  plan: checked.plan,
  declaration,
  contractRecord: checked.record,
  verification: {
    startedAt: "2026-08-12T10:00:00.000Z",
    sourceReference: "verification-run-001",
  },
  registration,
});
```

`veil.hypothesis-registration.v0` records the statement, when the idea became available, when it
was durably registered, and an opaque source-entry reference. `registeredAt` must be strictly before
`verification.startedAt` to receive `preregistered` status. A missing registration is not rewritten
as a violation: the candidate is marked `exploratory` and its future significance tier is `higher`.
A late, malformed, or wrong-hypothesis registration raises C6. Supplying anything other than a valid
contract record raises C5, while genuine C2/C3/C4 evidence failures retain their original invariant.

The low-level engine functions normalize and compare chronology; they do not manufacture a trusted
clock or session history. Stage 3 supplies both timestamps and resolves `source.reference` and
`verification.sourceReference` from durable Pi session entries. Passing arbitrary timestamps or
references directly to the library is not proof of preregistration.

The output `veil.promotion-candidate.v0` has structural status `contract-verified` but claim status
`unverified`. It carries only identities and future gate inputs: cost-model reference, declared trial
count, significance tier, and the still-required pricing/cost/statistical evidence. It has no metric,
verdict, or experiment id and therefore cannot satisfy C5 by itself.

## Identities have separate jobs

| Identity | Contains | Changes when |
| --- | --- | --- |
| Artifact | Code tree, runtime/entrypoint, locked choices, adapter hashes, development evidence, declared protocol | The promoted object or its declared provenance changes |
| Window read-set | Source read identity plus exact plan/fold/range and derived Arrow | A training window reads or derives different evidence |
| Executed run | Plan plus every successful training-window execution identity | A schedule, runtime, input, output, or execution changes |
| Verification view | Fresh source read plus plan/fold/decision, bounded history, mask audit, and exact Arrow | PIT evidence, decision time, history, or mask result changes |
| Contract record | Parameter lock plus every train/OOS view, child request/output, and admitted slice | Any C1-C4 execution evidence changes |
| Hypothesis registration | Statement, registration/idea timestamps, and durable source-entry reference | The registered idea, chronology, or source changes |
| Promotion candidate | Contract and registration identities plus future gate inputs and required evidence | Structural evidence, chronology, or gate inputs change |
| Experiment | Artifact plus all window executions, metrics, gates, and verdict | A verification run or outcome changes |

Each dataset's `developmentReadSets` records which exploration evidence led to promotion. These are
not reusable as execution windows and do not authorize a current source query. Every framed request
is instead bound to a newly guarded and derived view id. The training-only run and the complete
C1-C4 contract record both leave artifact identity unchanged. Neither is the final Experiment.

## The verification boundary

Veil, not factor code, owns source bindings, backend handles, credentials, schedules, and
decision-time reads. The implemented boundary:

1. derives deterministic rolling/expanding boundaries from an explicit UTC session schedule;
2. constructs a fresh point-in-time source read at each train cutoff and each OOS decision through
   the same backend-neutral temporal guard used by `veil-data`;
3. derives bounded history and removes false mask rows before the child starts;
4. passes only that Arrow IPC and immutable artifact metadata to a fresh subprocess;
5. validates child entity/event membership and admits only the current OOS decision slice;
6. issues a contract record only after the exact complete topology succeeds.

```text
SourceBinding + TemporalBackend
             |
 WFA plan → TemporalGuard(train or OOS decision)
             |
 source read-set → bounded history → mask-first verification view
                                        |
                                artifact subprocess
                                        |
                         membership + current OOS slice
                                        |
                           complete C1-C4 contract record
```

The subprocess will receive no raw source path, DSN, credential, backend object, or escape hatch to
a current query. A backend may be DuckDB, another database, a service, or an in-memory
implementation; that choice ends at the guard and is absent from both artifact and child protocols.

Framed execution proves one child ran against one exact guarded input. A training run proves every
declared training fold executed. A contract record additionally proves every declared OOS decision
used a fresh PIT, mask-first view and one parameter lock. None of these identities contains a priced
metric; all metrics remain uncitable until an Experiment record applies pricing, costs, and gates.
