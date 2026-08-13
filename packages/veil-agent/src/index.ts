export {
  detectExplorationAdvisory,
  type ExplorationAdvisory,
} from "./advisory.ts";
export {
  VEIL_ADVISORY_ENTRY,
  VEIL_AGENT_ENTRY_TYPES,
  VEIL_AGENT_TOOL_RESULT_FORMAT,
  VEIL_BACKTEST_TOOL,
  VEIL_BRIEF_ENTRY,
  VEIL_DATA_READ_ENTRY,
  VEIL_DATA_TOOL,
  VEIL_HYPOTHESIS_ENTRY,
  VEIL_MEMORY_TOOL,
  VEIL_PROJECT_FORMAT,
  VEIL_PROMOTION_REQUEST_FORMAT,
  VEIL_RESEARCH_LOG_REFERENCE,
  VEIL_RUN_EVIDENCE_FORMAT,
  VEIL_RUN_RESULT_ENTRY,
  VEIL_VERIFICATION_START_ENTRY,
  VEIL_VIOLATION_ENTRY,
} from "./constants.ts";
export {
  executeVeilDataTool,
  type VeilDataToolInput,
  type VeilDataToolResult,
} from "./data.ts";
export {
  describeVeilError,
  type PublicVeilError,
  VeilAgentError,
} from "./errors.ts";
export {
  createVeilExtension,
  type VeilExtensionOptions,
} from "./extension.ts";
export {
  type AdvisoryCode,
  type AdvisoryEntryData,
  type BriefEntryData,
  type CaptureMode,
  candidateSummary,
  createBriefEntry,
  createHypothesisEntry,
  createVerificationStartEntry,
  type DataReadEntryData,
  type DurableLedgerEntry,
  findVerificationStart,
  type HypothesisEntryData,
  hypothesisRegistrationFromEntry,
  latestHypothesis,
  type RunCandidateSummary,
  type RunResultEntryData,
  reconstructSessionLedger,
  type VeilSessionLedger,
  type VerificationStartEntryData,
  type ViolationEntryData,
} from "./ledger.ts";
export {
  executeVeilMemoryTool,
  type VeilMemoryAction,
  type VeilMemoryToolInput,
  type VeilMemoryToolResult,
} from "./memory.ts";
export {
  existingProjectPath,
  loadVeilProject,
  projectOutputPath,
  projectReference,
  type VeilProjectDataset,
  type VeilProjectLoader,
  type VeilProjectRuntime,
} from "./project.ts";
export {
  assertPromotionDataSemantics,
  executeVeilBacktestTool,
  type VeilBacktestFailure,
  type VeilBacktestSuccess,
  type VeilBacktestToolInput,
  type VeilBacktestToolResult,
} from "./promotion.ts";
