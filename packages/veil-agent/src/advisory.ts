import type { AdvisoryCode } from "./ledger.ts";

const DETECTORS: readonly {
  readonly code: AdvisoryCode;
  readonly pattern: RegExp;
  readonly message: string;
}[] = Object.freeze([
  {
    code: "FULL_SAMPLE",
    pattern:
      /(?:full[- ]sample|whole[- ]sample|global\s+(?:mean|standard deviation|std)|fit_transform\s*\(|all[- ]period)/iu,
    message:
      "Possible full-sample transformation: fit preprocessing inside each training fold and lock it before OOS execution.",
  },
  {
    code: "FUTURE_FUNCTION",
    pattern:
      /(?:shift\s*\(\s*-\d|lead\s*\(|lookahead|future[_ -](?:return|price|data)|\bi\s*\+\s*1\b)/iu,
    message:
      "Possible future-looking operation: confirm every feature is available at the declared decision time.",
  },
  {
    code: "SURVIVORSHIP",
    pattern:
      /(?:current\s+(?:constituents|members|universe)|latest\s+(?:constituents|members|universe)|survivorship)/iu,
    message:
      "Possible survivorship-biased universe: use point-in-time membership and apply the tradability mask before signals.",
  },
]);

export interface ExplorationAdvisory {
  readonly codes: readonly AdvisoryCode[];
  readonly text: string;
}

/** Heuristics only: callers may append this text, but must never block or alter tool success. */
export function detectExplorationAdvisory(input: string): ExplorationAdvisory | null {
  const sample = input.slice(0, 64 * 1024);
  const matches = DETECTORS.filter((detector) => detector.pattern.test(sample));
  if (matches.length === 0) return null;
  return Object.freeze({
    codes: Object.freeze(matches.map((match) => match.code)),
    text:
      "Veil advisory (exploration remains unblocked):\n" +
      matches.map((match) => `- ${match.message}`).join("\n") +
      "\nOnly promotion-time engine evidence can support a claim.",
  });
}
