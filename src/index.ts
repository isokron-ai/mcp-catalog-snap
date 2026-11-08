/**
 * mcp-catalog-snap — programmatic API.
 *
 * ```ts
 * import { capture, buildSnapshot, diffCatalogs, evaluate } from 'mcp-catalog-snap';
 * const live = buildSnapshot(await capture({ kind: 'stdio', command: 'npx', args: ['-y', 'kronicle-lite', 'serve'] }));
 * const diff = diffCatalogs(stored.catalog, live.catalog);
 * const { drift } = evaluate(diff, { ignoreDescriptions: true });
 * ```
 */

export { canonicalJson, fingerprint, prettyCanonical, sortKeysDeep, type JsonValue } from './canonical.js';
export {
  capture,
  captureFromTransport,
  describeTarget,
  listCatalog,
  openSession,
  openSessionOnTransport,
  type CaptureOptions,
  type Session,
  type HttpTarget,
  type StdioTarget,
  type Target,
} from './capture.js';
export {
  DEFAULT_CONFIG_FILE,
  DEFAULT_SNAPSHOT_DIR,
  expandEnv,
  loadConfig,
  parseConfig,
  type CatalogConfig,
  type ServerSpec,
} from './config.js';
export {
  SECTIONS,
  diffCatalogs,
  diffSection,
  diffValues,
  evaluate,
  type CatalogDiff,
  type ChangedEntry,
  type DriftPolicy,
  type PathChange,
  type Section,
  type SectionDiff,
  type Verdict,
} from './diff.js';
export { renderDiff, renderSnapshotHeader, type CheckReport, type RenderOptions, type ServerResult } from './render.js';
export {
  SNAPSHOT_FORMAT,
  buildSnapshot,
  normalizeCatalog,
  parseSnapshot,
  safeFileName,
  serializeSnapshot,
  snapshotSelfConsistent,
  type BuildOptions,
  type Catalog,
  type CatalogPrompt,
  type CatalogResourceTemplate,
  type CatalogTool,
  type RawCapture,
  type ServerInfo,
  type Snapshot,
} from './snapshot.js';
export {
  EXIT_DRIFT,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_TAMPERED,
  SnapshotIntegrityError,
  cmdCheck,
  cmdDiff,
  cmdHash,
  cmdSnapshot,
  type CheckOptions,
  type DiffOptions,
  type HashOptions,
  type IO,
  type SnapshotOptions,
} from './commands.js';
export {
  ADAPTERS,
  EXEC_PROFILES,
  POSTHOG_EXEC,
  TOOLS_LIST_ADAPTER,
  loadSweepInput,
  parseToolNames,
  parseToolsListFile,
  sourceOf,
  type ExecProfile,
  type ExecRecord,
  type LoadOptions,
  type SourceInfo,
  type SweepInput,
} from './adapters/index.js';
export {
  ANTHROPIC_API_KEY_ENV,
  DEFAULT_ANTHROPIC_MODEL,
  anthropicToolCounts,
  type AnthropicCountOptions,
  type AnthropicCounts,
} from './anthropic.js';
export {
  ANALYZE_MAX_CHARS,
  CHOICE_LIST_EDGES,
  DEFAULT_MAX_ICON_BYTES,
  RULES,
  analyzeCallResult,
  analyzeTool,
  compareFindings,
  dedupRefs,
  iconFindings,
  oversizeFinding,
  summarizeFindings,
  type ChoiceList,
  type DuplicateStats,
  type Finding,
  type FindingsOptions,
  type RuleId,
  type RuleSummary,
  type Severity,
  type ToolAnalysis,
  type UntypedStats,
} from './findings.js';
export {
  MODEL_VISIBLE_FIELDS,
  MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS,
  TOOL_FIELDS,
  addMeasures,
  contractFingerprint,
  distribution,
  emptyMeasure,
  histogram,
  measure,
  measureTool,
  modelVisibleText,
  orderedToolsFingerprint,
  percentile,
  type Distribution,
  type Measure,
  type ToolField,
  type ToolMetrics,
} from './metrics.js';
export {
  BUILTIN_TOKENIZERS,
  TOKENIZE_CHUNK,
  chunkText,
  REFERENCE_TOKENIZER,
  loadTokenizer,
  loadTokenizers,
  registerTokenizer,
  utf8Bytes,
  type Tokenizer,
  type TokenizerFactory,
} from './tokenize.js';
export { EXIT_BUDGET, cmdSweep, type SweepCommandOptions } from './cmd-sweep.js';
export { mdCode, mdText, renderSweepMarkdown, type MarkdownOptions } from './report-md.js';
export {
  DEFAULT_ADVISORY_TOOL_TOKENS,
  REPORT_FORMAT,
  runSweep,
  serializeReport,
  type SweepOptions,
  type SweepReport,
  type ToolReport,
} from './sweep.js';
export { VERSION } from './version.js';
