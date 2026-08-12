export type EngineConfigurationErrorCode =
  | "INVALID_BACKEND"
  | "INVALID_BACKEND_ID"
  | "DUPLICATE_BACKEND"
  | "BACKEND_NOT_FOUND"
  | "BACKEND_SOURCE_UNSUPPORTED"
  | "BACKEND_READ_FAILED"
  | "BINDING_BACKEND_MISMATCH"
  | "INVALID_BINDING"
  | "INVALID_QUERY"
  | "INVALID_BACKEND_RESULT";

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
