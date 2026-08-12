# Content-addressed artifact identity

This example captures an explicit two-file Python code package, attaches locked parameters, adapter
semantics, a real guarded development read-set, and a walk-forward protocol, then creates
`veil.artifact.v0`.

It copies the same code into a new absolute root with different mtimes and creation order. Both roots
produce the same code-tree and artifact identities. A clean Node process then verifies the serialized
manifest and copied code without constructing a backend or source binding.

```bash
npm run artifact:verify
```

This example intentionally stops at portable identity; the separate
[`artifact-execution`](../artifact-execution/) example runs a promoted artifact through the framed
child boundary. This example removes only its newly created temporary directory.
