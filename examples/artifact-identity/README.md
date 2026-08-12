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

The Python function is packaged but not executed in this slice. Framed subprocess execution is the
next Stage 2C boundary. The example removes only its newly created temporary directory.
