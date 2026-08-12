# Operator-controlled snapshot recovery

This example deliberately truncates a snapshot inside a temporary store, then exercises the narrow
recovery workflow:

1. `inspect()` classifies the object as `invalid` without changing it;
2. a separately opened recovery capability records an operator, reason, and durable intent;
3. `quarantine()` atomically moves the corrupt object out of the readable namespace and writes a
   hash-verified completion record;
4. the caller explicitly republishes the original guarded manifest and Arrow evidence;
5. a clean Node process reopens both the restored snapshot and the recovery audit by content id.

Run it from the repository root:

```bash
npm run snapshot-recovery:verify
```

Recovery never queries the current source, treats a mismatched external verification claim as proof
of corruption, deletes the quarantined bytes, or overwrites an object in place. Valid and missing
objects are refused. Per-snapshot locks make concurrent recovery attempts converge on at most one
quarantine operation, and ordinary `put()` fails while that operator action owns the lock.

The example removes only its newly created temporary store after verification.
