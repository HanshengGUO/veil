import { normalizeIsoInstant } from "./time.ts";

/** Normalizes a required decision time without exposing declaration-internal path plumbing. */
export function normalizeDecisionTime(value: unknown): string {
  return normalizeIsoInstant(value, "$asOf");
}
