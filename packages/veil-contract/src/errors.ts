export type AdapterDeclarationErrorCode =
  | "INVALID_TYPE"
  | "MISSING_FIELD"
  | "UNKNOWN_FIELD"
  | "INVALID_VALUE"
  | "CONTRADICTORY_DECLARATION"
  | "MISSING_EVIDENCE"
  | "INVALID_SEGMENTS"
  | "INLINE_SECRET"
  | "LINEAGE_MISMATCH"
  | "OBSERVED_BEFORE_LINEAGE";

/** A stable, field-addressable error raised while registering an adapter declaration. */
export class AdapterDeclarationError extends Error {
  readonly code: AdapterDeclarationErrorCode;
  readonly path: string;
  readonly remedy: string;

  constructor(code: AdapterDeclarationErrorCode, path: string, message: string, remedy: string) {
    super(`[${code}] ${path}: ${message}`);
    this.name = "AdapterDeclarationError";
    this.code = code;
    this.path = path;
    this.remedy = remedy;
  }

  describe(): string {
    return `${this.message} Remedy: ${this.remedy}`;
  }
}
