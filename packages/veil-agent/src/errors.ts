import { AdapterDeclarationError, ContractViolation } from "@veilquant/contract";
import { EngineConfigurationError } from "@veilquant/engine";

export class VeilAgentError extends Error {
  readonly code: string;
  readonly remedy: string;

  constructor(code: string, message: string, remedy: string) {
    super(`[${code}] ${message}`);
    this.name = "VeilAgentError";
    this.code = code;
    this.remedy = remedy;
  }
}

export interface PublicVeilError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly remedy: string;
  readonly invariant?: string;
  readonly field?: string;
}

/** Converts trusted errors to a model-facing diagnostic without paths, credentials, or child stderr. */
export function describeVeilError(error: unknown): PublicVeilError {
  if (error instanceof ContractViolation) {
    return Object.freeze({
      ok: false,
      code: error.invariant,
      invariant: error.invariant,
      message: publicMessage(error.message),
      remedy: publicMessage(
        error.detail.remedy ?? "Correct the contract violation and start a new verification run.",
      ),
    });
  }
  if (error instanceof AdapterDeclarationError) {
    return Object.freeze({
      ok: false,
      code: error.code,
      message: publicMessage(error.message),
      field: error.path,
      remedy: publicMessage(error.remedy),
    });
  }
  if (error instanceof EngineConfigurationError || error instanceof VeilAgentError) {
    return Object.freeze({
      ok: false,
      code: error.code,
      message: publicMessage(error.message),
      remedy: publicMessage(error.remedy),
    });
  }
  return Object.freeze({
    ok: false,
    code: "UNEXPECTED_ERROR",
    message: "Veil could not complete the operation without a public diagnostic.",
    remedy:
      "Retry with the smallest project fixture and report only the public error, Node version, and Veil version.",
  });
}

function publicMessage(input: string): string {
  return input.replace(/(?:[A-Za-z]:)?[\\/][^\s"']+/gu, "[private path]");
}
