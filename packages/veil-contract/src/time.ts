import { AdapterDeclarationError } from "./errors.ts";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_DATE_TIME = /(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_DURATION =
  /^P(?=.+)(?:\d+(?:\.\d+)?Y)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?W)?(?:\d+(?:\.\d+)?D)?(?:T(?=\d)(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/;

export function normalizeIsoInstant(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdapterDeclarationError(
      "INVALID_TYPE",
      path,
      "expected a non-empty ISO-8601 date or timestamp",
      "Use YYYY-MM-DD or an ISO-8601 timestamp with an explicit timezone.",
    );
  }

  const candidate = value.trim();
  if (DATE_ONLY.test(candidate)) {
    const parsed = new Date(`${candidate}T00:00:00.000Z`);
    if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== candidate) {
      throw invalidInstant(path);
    }
    return parsed.toISOString();
  }

  if (!ZONED_DATE_TIME.test(candidate)) {
    throw new AdapterDeclarationError(
      "INVALID_VALUE",
      path,
      "timestamp has no explicit timezone",
      "Add Z or a numeric offset; Veil normalizes all declaration boundaries to UTC.",
    );
  }

  const epoch = Date.parse(candidate);
  if (!Number.isFinite(epoch)) {
    throw invalidInstant(path);
  }
  return new Date(epoch).toISOString();
}

export function normalizePositiveIsoDuration(value: unknown, path: string): string {
  if (typeof value !== "string" || !ISO_DURATION.test(value.trim()) || !/[1-9]/.test(value)) {
    throw new AdapterDeclarationError(
      "INVALID_VALUE",
      path,
      "expected a positive ISO-8601 duration",
      "Use a duration such as PT15M, PT6H, or P2D.",
    );
  }
  return value.trim();
}

function invalidInstant(path: string): AdapterDeclarationError {
  return new AdapterDeclarationError(
    "INVALID_VALUE",
    path,
    "invalid ISO-8601 date or timestamp",
    "Use a real calendar date or a timestamp with an explicit timezone.",
  );
}
