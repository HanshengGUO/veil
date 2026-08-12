# Multi-file point-in-time source

This example uses one portable glob, `data/*.csv`, to read two CSV members as a single guarded view.
Run it from the repository root:

```bash
npm run multi-file-pit:verify
```

Veil resolves the glob beneath the opaque binding root, sorts matching files by root-relative
logical name, hashes each file, builds a `veil.source-manifest.v0`, and passes that exact sorted path
list to DuckDB. The backend captures the complete set again after the query. A matching file being
added, removed, renamed, or modified during the read raises `SOURCE_CHANGED` instead of returning a
mixed-version view.

The source manifest contains logical names, byte lengths, and content hashes. It contains no absolute
root, binding id, discovery order, mtime, hostname, or credentials, so copying the same members to a
different root preserves source and read-set identity.
