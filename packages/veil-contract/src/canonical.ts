import { createHash } from "node:crypto";
import type { AdapterDeclaration } from "./adapter.ts";

const ADAPTER_HASH_DOMAIN = "veil.adapter.v1";

export function canonicalizeAdapterDeclaration(declaration: AdapterDeclaration): string {
  return canonicalJson(declaration);
}

export function hashAdapterDeclaration(declaration: AdapterDeclaration): string {
  const digest = createHash("sha256")
    .update(ADAPTER_HASH_DOMAIN)
    .update("\0")
    .update(canonicalizeAdapterDeclaration(declaration))
    .digest("hex");
  return `sha256:${digest}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}
