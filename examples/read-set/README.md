# Read-set v0 cold reproduction

This example materializes the two pieces needed to verify one guarded read:

```text
read-set.json   versioned declaration/source/query/result identities
data.arrow      the exact guarded Arrow evidence
```

Run it from the repository root:

```bash
npm run read-set:verify
```

The script performs a real CSV point-in-time read, writes both files to a fresh temporary directory,
loads them back, and independently verifies the manifest against the declaration, source
fingerprint, expected manifest id, and Arrow rows. The temporary directory is removed afterward.

The manifest deliberately excludes absolute roots, binding ids, mtimes, hostnames, and secrets. It
is an identity envelope, not yet a durable snapshot store; persistence and multi-file source
manifests arrive in the Stage 2B snapshot slice.
