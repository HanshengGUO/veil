# Read-set identity

A guarded Arrow view now carries a `veil.read-set.v0` manifest describing what produced it and what
rows were actually delivered. The manifest separates five identities that must not be collapsed:

| Identity | Meaning |
| --- | --- |
| `declarationHash` | Normalized adapter semantics, including its portable source declaration |
| `source.fingerprint` | Physical input version reported by the backend, optionally with its exact source manifest; `null` means non-reproducible |
| `queryHash` | Dataset, adapter version, normalized `as_of`, projection, predicate, and filter version |
| `result.resultHash` | Canonical schema plus the multiset of guarded Arrow rows |
| `result.arrowHash` | Exact guarded Arrow IPC bytes delivered by this read |

`manifestHash` content-addresses those identities together with engine, Arrow, backend, and backend
runtime versions. Consequently, two physical formats can have different declaration/source/manifest
hashes while sharing one logical result hash.

## Canonical result rules

Read-set v0 sorts schema fields by column name, hashes each row in that canonical column order, then
sorts the row hashes before computing `resultHash`. Duplicate rows remain duplicated. This makes the
identity independent of physical column order, input row order, absolute path, and Arrow IPC buffer
layout. It does not reorder the Arrow view returned to factor code. `arrowHash` intentionally remains
order- and layout-sensitive so a stored snapshot proves the exact delivery evidence; both hashes are
needed for metric-level reproduction.

Primitive Arrow scalars, nulls, binary values, 64-bit integers, timestamps, `NaN`, infinities, and
negative zero have explicit encodings. Unsupported nested values fail with `INVALID_READ_SET` rather
than receiving an unstable identity. The canonicalization and temporal-filter versions are embedded
in every manifest so future algorithms cannot silently reuse old hashes.

## Verify stored evidence

```ts
import { verifyReadSetManifest } from "@veilquant/engine";

const verified = verifyReadSetManifest(parsedManifest, {
  arrowIpc: storedArrowBytes,
  declaration,
  sourceFingerprint: replayedSourceFingerprint,
  expectedManifestHash: experiment.readSetId,
});
```

Verification strictly parses the manifest, recomputes its query, schema, result, and manifest hashes,
recomputes the exact Arrow content hash, and compares any supplied declaration, source fingerprint,
and expected id. Corrupt Arrow bytes, unknown fields, changed rows, changed layout/order, or stale
identities fail loudly as `INVALID_READ_SET`.

Always provide the expected manifest id when reproducing an experiment. Hashes are content
addresses, not signatures: a self-consistent replacement manifest is detectable only when compared
with the id already recorded by the experiment. A `null` source fingerprint is valid for exploration
but cannot support a reproducible promotion claim.

## Multi-file source identity

The default file backend embeds a `veil.source-manifest.v0` in its source fingerprint. Each entry has
only stable physical evidence:

```json
{
  "logicalName": "prices/year=2026/part-00.parquet",
  "byteLength": 12345,
  "contentHash": "sha256:..."
}
```

Logical names are relative to the opaque binding root and use forward slashes. Entries are unique
and sorted before the manifest is hashed; the fingerprint's SHA-256 value identifies the complete
manifest. The verifier independently checks entry shape/order, every hash encoding, the manifest
hash, and the fingerprint-to-manifest link. Legacy or custom backend fingerprints without an
embedded file manifest remain valid—the generic backend interface is not tied to files or a
particular database.

The default backend captures the complete matching set before and after every query, hashes file
contents both times, and gives DuckDB the first capture's exact sorted path list. Adding, deleting,
renaming, or replacing one matching member therefore changes source identity and, if it occurs during
the read, fails with `SOURCE_CHANGED`. Copying identical logical members to another absolute root,
changing mtimes, or creating them in another discovery order leaves source and read-set identity
unchanged.

## Durable snapshots

`ReadSetSnapshotStore` persists an already-guarded manifest and its exact Arrow IPC as one
content-addressed object. Storage remains backend-neutral: the store knows nothing about DuckDB,
CSV, Parquet, database connections, or how the view was produced.

```ts
import { openReadSetSnapshotStore } from "@veilquant/engine";

const store = await openReadSetSnapshotStore({ root: "/absolute/veil-snapshots" });
const written = await store.put(result.readSet, result.arrowIpc);

// Record written.snapshot.id with the experiment, then replay by that exact id.
const replayed = await store.read(written.snapshot.id, {
  declaration,
  sourceFingerprint: result.sourceFingerprint,
});
```

The snapshot id is the read-set `manifestHash`. Objects are sharded under
`read-set-snapshots-v0/<first-two-hex>/<manifest-hex>/` and contain exactly `manifest.json` and
`data.arrow`. Absolute store paths never enter the identity or the store's JSON representation, so
copying the namespace to another absolute root preserves every id.

Publication writes both files exclusively inside a temporary directory in the destination shard,
syncs the files and directory metadata where the platform supports it, atomically renames the
directory into place, then syncs the shard where supported. Concurrent writers for the same id
converge on the one verified object; a losing writer re-reads and validates the winner. Every cache
hit and replay parses the manifest again, verifies its expected id, recomputes the exact Arrow and
logical result hashes, and rejects missing, extra, symlinked, truncated, or tampered files.

`SNAPSHOT_NOT_FOUND` means the entire requested object is absent. `INVALID_SNAPSHOT` means an object
exists but cannot prove the requested evidence. Neither condition triggers a query against the
current source, and `put()` will not overwrite a corrupt object with newly generated bytes. Restore
the exact object from trusted storage or use the operator-controlled quarantine workflow below.

## Inspect and recover without erasing evidence

`inspect()` fully verifies the object but converts the two expected operator states into structured
results:

```ts
const state = await store.inspect(snapshotId, {
  declaration,
  sourceFingerprint,
});
// state.status is "valid", "missing", or "invalid"
```

Inspection is read-only. `invalid` means the object failed the supplied verification request; it can
also mean that the object is intrinsically corrupt. These are deliberately not treated as the same
authorization to mutate storage. Recovery re-checks the object without caller-supplied evidence and
refuses to quarantine a valid object, even when an earlier inspection used a wrong declaration or
source fingerprint.

The mutation capability is opened separately and requires an operator identity and printable
reason:

```ts
import { openReadSetSnapshotRecovery } from "@veilquant/engine";

const recovery = await openReadSetSnapshotRecovery({ root: "/absolute/veil-snapshots" });
const audit = await recovery.quarantine({
  snapshotId,
  actor: "alice.ops",
  reason: "data.arrow was truncated after a disk failure.",
});

// Re-read and hash-verify the durable intent/result audit.
await recovery.read(audit.operationId);
```

Quarantine is not delete or repair-in-place. Under a per-snapshot operator lock it verifies intrinsic
corruption twice, durably writes an intent, atomically renames the original object into
`read-set-snapshot-quarantine-v0`, syncs the affected directories where supported, then writes a
content-hashed completion record. The corrupt bytes remain available for forensics but disappear
from the normal read namespace. Valid and missing targets are refused; concurrent operators produce
at most one completed quarantine. A normal `put()` returns `SNAPSHOT_RECOVERY_BUSY` while the lock is
owned and never clears that lock automatically.

Restoration is another explicit action. Obtain the exact trusted manifest and Arrow bytes—never a
fresh query masquerading as the old read-set—then call `store.put(manifest, arrowIpc)`. The content
id must reproduce the quarantined `snapshotId`; the quarantine audit remains independently readable.
There is intentionally no automatic healing policy and no API that deletes quarantined evidence.

Run `npm run snapshot-recovery:verify` to simulate truncation in a temporary store, quarantine it,
explicitly republish the original guarded evidence, and verify both snapshot and audit from a clean
process. The implementation also refuses symlinked shards and moves a symlinked object itself rather
than following its target.

## Current limits

Absolute binding roots, binding ids, mtimes, hostnames, credentials, and secret references do not
enter read-set identity. The default file backend supports one file or an explicitly matched
CSV/Parquet set; it does not infer partition semantics beyond the declared locator. Like the current
guard, v0 materializes the table and sorts row hashes in memory; streaming or external
canonicalization is not claimed yet. The local snapshot store does not yet provide remote transport,
garbage collection, deletion of quarantined evidence, or an automatic healing policy. `veil-data`
returns these guarded bytes and can write them only through an explicitly selected snapshot output;
see [`docs/veil-data.md`](./veil-data.md).

Run the independent-process snapshot replay with `npm run read-set:verify`; its source is under
[`examples/read-set`](../examples/read-set/).
