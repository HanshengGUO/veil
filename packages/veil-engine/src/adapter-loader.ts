import { readFile } from "node:fs/promises";
import {
  type AdapterDeclaration,
  AdapterDeclarationError,
  normalizeAdapterDeclaration,
} from "@veilquant/contract";
import { parseDocument } from "yaml";
import { EngineConfigurationError } from "./errors.ts";

/** I/O stays in engine; contract receives only the parsed unknown value. */
export async function loadAdapterFile(path: string | URL): Promise<AdapterDeclaration> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch {
    throw new EngineConfigurationError(
      "ADAPTER_LOAD_FAILED",
      "adapter declaration could not be read",
      "Pass an existing UTF-8 adapter YAML file.",
    );
  }

  try {
    const document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
    if (document.errors.length > 0 || document.warnings.length > 0) {
      throw new Error("invalid adapter YAML");
    }
    return normalizeAdapterDeclaration(document.toJS({ maxAliasCount: 100 }));
  } catch (cause) {
    if (cause instanceof EngineConfigurationError) {
      throw cause;
    }
    if (cause instanceof AdapterDeclarationError) {
      throw cause;
    }
    throw new EngineConfigurationError(
      "ADAPTER_LOAD_FAILED",
      "adapter declaration is not valid strict YAML",
      "Fix YAML syntax, duplicate keys, aliases, or unsupported tags and retry.",
    );
  }
}
