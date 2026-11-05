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
  type CaptureOptions,
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
  ANTHROPIC_API_KEY_ENV,
  DEFAULT_ANTHROPIC_MODEL,
  anthropicToolCounts,
  type AnthropicCountOptions,
  type AnthropicCounts,
} from './anthropic.js';
export {
  CHOICE_LIST_EDGES,
  RULES,
  analyzeCallResult,
  analyzeTool,
  compareFindings,
  dedupRefs,
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
  TOOL_FIELDS,
  addMeasures,
  contractFingerprint,
  distribution,
  emptyMeasure,
  histogram,
  measure,
  measureTool,
  orderedToolsFingerprint,
  percentile,
  type Distribution,
  type Measure,
  type ToolField,
  type ToolMetrics,
} from './metrics.js';
export {
  BOUNDED_TOKENIZE_ABOVE,
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
export { VERSION } from './version.js';
