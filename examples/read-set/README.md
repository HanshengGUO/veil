# Durable read-set cold reproduction

This example persists one guarded read in the content-addressed snapshot layout:

```text
read-set-snapshots-v0/<shard>/<manifest-hash>/
├── manifest.json   declaration/source/query/result identities
└── data.arrow      exact guarded Arrow evidence
```

Run it from the repository root:

```bash
npm run read-set:verify
```

The parent process performs a real CSV point-in-time read and atomically publishes the snapshot. It
first verifies the stored object against the declaration, source fingerprint, expected manifest id,
and Arrow rows. It then launches a clean child process with no backend or source binding and asks it
to reproduce the same identity from the snapshot alone. The temporary store is removed afterward.

The manifest and public store handle deliberately exclude absolute roots, binding ids, mtimes,
hostnames, and secrets. Publication uses same-directory temporary files, file sync, directory sync
where supported, and atomic rename. Missing, truncated, tampered, or unexpected files fail loudly;
the store never queries the current source as a substitute. File-backed read sets may now embed the
exact sorted multi-file source manifest verified before the snapshot is written.

For the separate operator path that inspects, quarantines, audits, and explicitly republishes a
corrupt object, run `npm run snapshot-recovery:verify` and see
[`examples/snapshot-recovery`](../snapshot-recovery/).
