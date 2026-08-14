# Stage 4 plugin template

This example implements and executes one custom `CostModel` and one custom `NullGenerator` using
only the public `@veilquant/engine` API:

```bash
npm run stage4-plugin:verify
```

Copy [`plugin.ts`](./plugin.ts), choose stable logical references, validate every required market
field, and replace the example semantic hash with the content hash of your shipped plugin build.
Raw configuration and callback code remain local; portable evidence carries only the version and
implementation/configuration hashes.

The conformance run exercises the same validation surface used by OOS pricing and statistical
gates. It rejects missing/reordered cost charges, negative or non-finite costs, malformed null
samples, duplicate provider references, and provider failures. A method passing this small harness
is loadable, not scientifically endorsed: document the market assumptions and add domain fixtures
before proposing it as an official provider.

For a Pi integration, create a `VeilProjectLoader`, call `loadVeilProject()`, register the custom
providers on its `costModels` and `nullGenerators` registries, and pass that loader to
`createVeilExtension({ projectLoader })`. The default YAML loader intentionally accepts only the
built-in audited provider kinds.
