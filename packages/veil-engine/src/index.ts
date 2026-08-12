export { loadAdapterFile } from "./adapter-loader.ts";
export {
  type BackendCapabilities,
  type BackendDescriptor,
  type BackendPushdownReport,
  type BackendReadRequest,
  type BackendReadResult,
  BackendRegistry,
  type BackendRuntime,
  type TemporalBackend,
} from "./backend.ts";
export { DUCKDB_FILE_BACKEND_ID, DuckDbFileBackend } from "./duckdb-file-backend.ts";
export * from "./errors.ts";
export {
  READ_SET_FILTER_VERSION,
  READ_SET_FORMAT,
  READ_SET_RESULT_VERSION,
  type ReadSetManifest,
  type ReadSetMetadataEntry,
  type ReadSetQueryEnvelope,
  type ReadSetResultIdentity,
  type ReadSetSchema,
  type ReadSetSchemaField,
  type ReadSetVerificationEvidence,
  verifyReadSetManifest,
} from "./read-set.ts";
export * from "./runtime-smoke.ts";
export {
  openReadSetSnapshotStore,
  READ_SET_SNAPSHOT_FORMAT,
  type ReadSetSnapshot,
  type ReadSetSnapshotEvidence,
  type ReadSetSnapshotReference,
  ReadSetSnapshotStore,
  type ReadSetSnapshotStoreInput,
  type ReadSetSnapshotWriteResult,
} from "./snapshot-store.ts";
export {
  createSourceBinding,
  type ResolvedSourceBinding,
  SourceBinding,
  type SourceBindingInput,
  type SourceBindingSummary,
} from "./source-binding.ts";
export {
  createSourceManifest,
  SOURCE_MANIFEST_FORMAT,
  type SourceFingerprint,
  type SourceManifest,
  type SourceManifestFile,
  sourceFingerprintFromManifest,
  verifySourceManifest,
} from "./source-manifest.ts";
export * from "./temporal-guard.ts";
export * from "./temporal-plan.ts";
