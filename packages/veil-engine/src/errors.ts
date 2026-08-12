export type EngineConfigurationErrorCode =
  | "ADAPTER_LOAD_FAILED"
  | "INVALID_BACKEND"
  | "INVALID_BACKEND_ID"
  | "DUPLICATE_BACKEND"
  | "BACKEND_NOT_FOUND"
  | "BACKEND_SOURCE_UNSUPPORTED"
  | "BACKEND_READ_FAILED"
  | "INVALID_SOURCE"
  | "SOURCE_CHANGED"
  | "INVALID_SOURCE_MANIFEST"
  | "BINDING_BACKEND_MISMATCH"
  | "INVALID_BINDING"
  | "INVALID_QUERY"
  | "INVALID_BACKEND_RESULT"
  | "INVALID_READ_SET"
  | "INVALID_SNAPSHOT_STORE"
  | "SNAPSHOT_NOT_FOUND"
  | "INVALID_SNAPSHOT";

export class EngineConfigurationError extends Error {
  readonly code: EngineConfigurationErrorCode;
  readonly remedy: string;

  constructor(code: EngineConfigurationErrorCode, message: string, remedy: string) {
    super(`[${code}] ${message}`);
    this.name = "EngineConfigurationError";
    this.code = code;
    this.remedy = remedy;
  }
}
