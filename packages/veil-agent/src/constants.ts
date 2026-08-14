export const VEIL_BRIEF_ENTRY = "veil.brief.v0" as const;
export const VEIL_HYPOTHESIS_ENTRY = "veil.hypothesis.v0" as const;
export const VEIL_DATA_READ_ENTRY = "veil.data-read.v0" as const;
export const VEIL_VERIFICATION_START_ENTRY = "veil.verification-start.v0" as const;
export const VEIL_RUN_RESULT_ENTRY = "veil.run-result.v0" as const;
export const VEIL_VIOLATION_ENTRY = "veil.violation.v0" as const;
export const VEIL_ADVISORY_ENTRY = "veil.advisory.v0" as const;
export const VEIL_EXPERIMENT_ENTRY = "veil.experiment-memory.v0" as const;

export const VEIL_PROJECT_FORMAT = "veil.project.v0" as const;
export const VEIL_PROMOTION_REQUEST_FORMAT = "veil.promotion-request.v0" as const;
export const VEIL_RUN_EVIDENCE_FORMAT = "veil.run-evidence.v0" as const;
export const VEIL_AGENT_TOOL_RESULT_FORMAT = "veil.agent-tool-result.v0" as const;
export const VEIL_EXPERIMENT_ARCHIVE_FORMAT = "veil.experiment-archive.v0" as const;

export const VEIL_DATA_TOOL = "veil-data" as const;
export const VEIL_BACKTEST_TOOL = "veil-backtest" as const;
export const VEIL_MEMORY_TOOL = "veil-memory" as const;

export const VEIL_PROJECT_REFERENCE = ".veil/project.yaml" as const;
export const VEIL_RESEARCH_LOG_REFERENCE = ".veil/research-log.md" as const;
export const VEIL_RUN_DIRECTORY_REFERENCE = ".veil/runs" as const;

export const VEIL_AGENT_ENTRY_TYPES = Object.freeze([
  VEIL_BRIEF_ENTRY,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_DATA_READ_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VIOLATION_ENTRY,
  VEIL_ADVISORY_ENTRY,
  VEIL_EXPERIMENT_ENTRY,
] as const);

export type VeilAgentEntryType = (typeof VEIL_AGENT_ENTRY_TYPES)[number];
