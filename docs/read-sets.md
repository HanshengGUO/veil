# Read-set identity

A guarded Arrow view now carries a `veil.read-set.v0` manifest describing what produced it and what
rows were actually delivered. The manifest separates five identities that must not be collapsed:

| Identity | Meaning |
| --- | --- |
| `declarationHash` | Normalized adapter semantics, including its portable source declaration |
| `source.fingerprint` | Physical input version reported by the backend; `null` means non-reproducible |
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

## What v0 does not store

Absolute binding roots, binding ids, mtimes, hostnames, credentials, and secret references do not
enter read-set identity. The current default file backend fingerprints one regular CSV or Parquet
file. Like the current guard, v0 materializes the table and sorts row hashes in memory; streaming or
external canonicalization is not claimed yet. Durable snapshot storage, multi-file source manifests,
cache recovery, and the `veil-data` export surface are the next Stage 2B slice.

Run the disk round-trip probe with `npm run read-set:verify`; its source is under
[`examples/read-set`](../examples/read-set/).
