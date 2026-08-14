/**
 * Atlas Type Definitions
 *
 * Core types for the semantic knowledge graph system.
 */

// =============================================================================
// Union Types
// =============================================================================

/**
 * Types of nodes in the knowledge graph.
 *
 * Defined as a runtime-iterable `as const` array so the same source
 * of truth backs both the TS type and any runtime validation
 * (e.g. the search query parser).
 */
export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
  'asset',
  // Note #9: inline rationale comments (WHY / NOTE / HACK / TODO) promoted to
  // first-class nodes by the extractor. Linked to the nearest enclosing symbol
  // by an `explains` edge. Extracted from source, not human-declared.
  'rationale',
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

/**
 * Types of edges (relationships) between nodes
 */
export type EdgeKind =
  | 'contains'        // Parent contains child (file→class, class→method)
  | 'calls'           // Function/method calls another
  | 'imports'         // File imports from another
  | 'exports'         // File exports a symbol
  | 'extends'         // Class/interface extends another
  | 'implements'      // Class implements interface
  | 'references'      // Generic reference to another symbol
  | 'type_of'         // Variable/parameter has type
  | 'returns'         // Function returns type
  | 'instantiates'    // Creates instance of class
  | 'overrides'       // Method overrides parent method
  | 'decorates'       // Decorator applied to symbol
  | 'describes'       // Asset node describes a code symbol (atlas-extension-plan Rung 3)
  | 'explains';       // Rationale node (WHY/NOTE/HACK/TODO comment) explains its enclosing symbol (note #9)

/**
 * Supported programming languages. See NODE_KINDS for why this is a
 * runtime-iterable const array.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'razor',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'astro',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'r',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
] as const;

export type Language = (typeof LANGUAGES)[number];

// =============================================================================
// Assets (atlas-extension-plan Rung 3)
// =============================================================================

/**
 * Human-attached knowledge (markdown notes, docs, design snippets) that lives
 * in the graph next to code. Assets are stored as rows in `nodes` with
 * `kind: 'asset'` (reusing FTS, edges FK, and the embedding sync pipeline);
 * the `assets` companion table holds asset-only extras. Link an asset to a
 * code symbol with a `describes` edge.
 */
export interface Asset {
  /** Node id (stable hash of source path). */
  id: string;
  /** Filename or user-provided label. */
  name: string;
  /** Path relative to project root. */
  sourcePath: string;
  /** MIME-ish type: 'text/markdown', 'text/plain', 'application/json', ... */
  contentType: string;
  /** Plain text extracted from the source (null for binary/unsupported types). */
  extractedText: string | null;
  /** Unix ms timestamp. */
  updatedAt: number;
}

// =============================================================================
// Core Graph Types
// =============================================================================

/**
 * A node in the knowledge graph representing a code symbol
 */
export interface Node {
  /** Unique identifier (hash of file path + qualified name) */
  id: string;

  /** Type of code element */
  kind: NodeKind;

  /** Simple name (e.g., "calculateTotal") */
  name: string;

  /** Fully qualified name (e.g., "src/utils.ts::MathHelper.calculateTotal") */
  qualifiedName: string;

  /** File path relative to project root */
  filePath: string;

  /** Programming language */
  language: Language;

  /** Starting line number (1-indexed) */
  startLine: number;

  /** Ending line number (1-indexed) */
  endLine: number;

  /** Starting column (0-indexed) */
  startColumn: number;

  /** Ending column (0-indexed) */
  endColumn: number;

  /** Documentation string if present */
  docstring?: string;

  /** Function/method signature */
  signature?: string;

  /** Visibility modifier */
  visibility?: 'public' | 'private' | 'protected' | 'internal';

  /** Whether symbol is exported */
  isExported?: boolean;

  /** Whether symbol is async */
  isAsync?: boolean;

  /** Whether symbol is static */
  isStatic?: boolean;

  /** Whether symbol is abstract */
  isAbstract?: boolean;

  /** Decorators/annotations applied */
  decorators?: string[];

  /** Generic type parameters */
  typeParameters?: string[];

  /**
   * Normalized return/result type name for a function/method (the bare class
   * name, smart-pointer pointee unwrapped). Captured for C/C++ so resolution
   * can infer a chained receiver's type from what the inner call returns —
   * `Foo::instance().bar()` resolves `bar` on `Foo` (issue #645). Undefined for
   * languages/symbols where it isn't captured.
   */
  returnType?: string;

  /** When the node was last updated */
  updatedAt: number;
}

/**
 * An edge representing a relationship between two nodes
 */
export interface Edge {
  /** Source node ID */
  source: string;

  /** Target node ID */
  target: string;

  /** Type of relationship */
  kind: EdgeKind;

  /** Additional context about the relationship */
  metadata?: Record<string, unknown>;

  /** Line number where relationship occurs (e.g., call site) */
  line?: number;

  /** Column number where relationship occurs */
  column?: number;

  /** How this edge was created */
  provenance?: 'tree-sitter' | 'scip' | 'heuristic';

  /**
   * How SURE we are of this hop between nodes (note #8 from atlas-extension-plan).
   * - `EXTRACTED`  — literal in source (import, direct call, JSX child, unique resolution)
   * - `INFERRED`   — reached via a synthesizer or second-pass conformance walk
   * - `AMBIGUOUS`  — resolution had >1 candidate; agent should verify before trusting
   * NULL/undefined = pre-migration edge with no tag (treated as EXTRACTED by callers
   * that need a value — the historical default before the column existed).
   */
  confidence?: EdgeConfidence;
}

/**
 * Edge-confidence tier (atlas-extension-plan note #8). Persisted on each edge so
 * downstream tools can distinguish a hop derived from literal source from one
 * resolved by heuristic or ambiguous match — the "how sure of this HOP" trust
 * multiplier that complements the per-hit provenance tags on {@link SearchResult}.
 */
export type EdgeConfidence = 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS';

/**
 * Metadata about a tracked file
 */
export interface FileRecord {
  /** File path relative to project root */
  path: string;

  /** Content hash for change detection */
  contentHash: string;

  /** Detected language */
  language: Language;

  /** File size in bytes */
  size: number;

  /** Last modification timestamp */
  modifiedAt: number;

  /** When last indexed */
  indexedAt: number;

  /** Number of nodes extracted */
  nodeCount: number;

  /** Any extraction errors */
  errors?: ExtractionError[];
}

// =============================================================================
// Extraction Types
// =============================================================================

/**
 * Result from parsing a source file
 */
export interface ExtractionResult {
  /** Extracted nodes */
  nodes: Node[];

  /** Extracted edges */
  edges: Edge[];

  /** References that couldn't be resolved yet */
  unresolvedReferences: UnresolvedReference[];

  /** Any errors during extraction */
  errors: ExtractionError[];

  /** Extraction duration in milliseconds */
  durationMs: number;
}

/**
 * Error during code extraction
 */
export interface ExtractionError {
  /** Error message */
  message: string;

  /** File path where the error occurred */
  filePath?: string;

  /** Line number if available */
  line?: number;

  /** Column number if available */
  column?: number;

  /** Error severity */
  severity: 'error' | 'warning';

  /** Error code for categorization */
  code?: string;
}

/**
 * Kinds an unresolved reference can carry. `function_ref` is internal-only —
 * a function name used as a VALUE (callback registration, #756). It never
 * becomes an edge kind: resolution maps it to a `references` edge targeting
 * function/method nodes only (see `matchFunctionRef`).
 */
export type ReferenceKind = EdgeKind | 'function_ref';

/**
 * A reference that couldn't be resolved during extraction
 */
export interface UnresolvedReference {
  /** ID of the node containing the reference */
  fromNodeId: string;

  /** Name being referenced */
  referenceName: string;

  /** Type of reference (call, type, import, etc.) */
  referenceKind: ReferenceKind;

  /** Location of the reference */
  line: number;
  column: number;

  /** File path where reference occurs (denormalized for performance) */
  filePath?: string;

  /** Language of the source file (denormalized for performance) */
  language?: Language;

  /** Possible qualified names it might resolve to */
  candidates?: string[];
}

// =============================================================================
// Query Types
// =============================================================================

/**
 * A subgraph containing a subset of the knowledge graph
 */
export interface Subgraph {
  /** Nodes in this subgraph */
  nodes: Map<string, Node>;

  /** Edges in this subgraph */
  edges: Edge[];

  /** Root node IDs (entry points) */
  roots: string[];

  /**
   * Retrieval confidence for context-style queries. `'low'` means the query
   * resolved only to isolated common-word matches (no entry point corroborated
   * by 2+ distinct query terms) — callers should surface an honest handoff to
   * explore/trace rather than present the results as comprehensive. Undefined
   * for graph traversals that don't run the search-ranking path.
   */
  confidence?: 'high' | 'low';

  /**
   * Per-node retrieval channels (atlas-extension-plan note #4). Which seed
   * channel(s) surfaced each entry-point node — `keyword` (FTS/exact-name),
   * `vector` (semantic), `grep` (literal ripgrep); nodes pulled in by traversal
   * from another seed tag `graph`. Keyed by node id. Only populated for nodes
   * that entered via the search-ranking path — pure traversal callers leave it
   * empty. Consumed by MCP formatters to tag entries with `[via: …]`.
   */
  nodeChannels?: Map<string, SearchChannel[]>;
}

/**
 * Options for graph traversal
 */
export interface TraversalOptions {
  /** Maximum depth to traverse (default: Infinity) */
  maxDepth?: number;

  /** Edge types to follow (default: all) */
  edgeKinds?: EdgeKind[];

  /** Node types to include (default: all) */
  nodeKinds?: NodeKind[];

  /** Direction of traversal */
  direction?: 'outgoing' | 'incoming' | 'both';

  /** Maximum nodes to return */
  limit?: number;

  /** Whether to include the starting node */
  includeStart?: boolean;
}

/**
 * Options for searching the graph
 */
export interface SearchOptions {
  /** Node types to search */
  kinds?: NodeKind[];

  /** Languages to include */
  languages?: Language[];

  /** File path patterns to include */
  includePatterns?: string[];

  /** File path patterns to exclude */
  excludePatterns?: string[];

  /** Maximum results to return */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Whether search is case-sensitive */
  caseSensitive?: boolean;
}

/**
 * A search result with relevance scoring
 */
export interface SearchResult {
  /** Matching node */
  node: Node;

  /**
   * Relevance score for relative ranking only — higher is more relevant.
   * NOT normalized and NOT a 0-1 fraction: the FTS path returns an unbounded
   * BM25 magnitude (often in the tens or hundreds), while the fuzzy/exact
   * paths return ~0-1. Use it to order results, not as an absolute percentage.
   */
  score: number;

  /** Matched text snippets for highlighting */
  highlights?: string[];

  /**
   * Which retrieval channel(s) surfaced this hit (atlas-extension-plan note #4).
   * `keyword` = FTS or exact-name match; `vector` = semantic embedding neighbor;
   * `grep` = literal text match via ripgrep third channel; `graph` = pulled in by
   * traversal from another seed. Accumulates across channels — a node that
   * matches BOTH FTS and vector carries both, which is the strongest trust
   * signal downstream tools can display.
   */
  channels?: SearchChannel[];
}

/** Retrieval channel that surfaced a {@link SearchResult}. See `channels`. */
export type SearchChannel = 'keyword' | 'vector' | 'grep' | 'graph';

// =============================================================================
// Context Types
// =============================================================================

/**
 * Context information for code understanding
 */
export interface Context {
  /** Primary node being examined */
  focal: Node;

  /** Nodes containing the focal node (file, class, etc.) */
  ancestors: Node[];

  /** Nodes directly contained by focal node */
  children: Node[];

  /** Incoming references (who calls/uses this) */
  incomingRefs: Array<{ node: Node; edge: Edge }>;

  /** Outgoing references (what this calls/uses) */
  outgoingRefs: Array<{ node: Node; edge: Edge }>;

  /** Related type information */
  types: Node[];

  /** Relevant imports */
  imports: Node[];
}

/**
 * A block of code with context
 */
export interface CodeBlock {
  /** The code content */
  content: string;

  /** File path */
  filePath: string;

  /** Starting line */
  startLine: number;

  /** Ending line */
  endLine: number;

  /** Language for syntax highlighting */
  language: Language;

  /** Associated node if extracted */
  node?: Node;
}

// =============================================================================
// Database Types
// =============================================================================

/**
 * Database schema version info
 */
export interface SchemaVersion {
  /** Current schema version */
  version: number;

  /** When schema was created/updated */
  appliedAt: number;

  /** Description of this version */
  description?: string;
}

/**
 * Statistics about the knowledge graph
 */
export interface GraphStats {
  /** Total number of nodes */
  nodeCount: number;

  /** Total number of edges */
  edgeCount: number;

  /** Number of tracked files */
  fileCount: number;

  /** Node counts by kind */
  nodesByKind: Record<NodeKind, number>;

  /** Edge counts by kind */
  edgesByKind: Record<EdgeKind, number>;

  /** File counts by language */
  filesByLanguage: Record<Language, number>;

  /** Database size in bytes */
  dbSizeBytes: number;

  /** Last update timestamp */
  lastUpdated: number;
}

// =============================================================================
// Task Context Types (for buildContext)
// =============================================================================

/**
 * Input for building task context
 */
export type TaskInput = string | { title: string; description?: string };

/**
 * Options for building task context
 */
export interface BuildContextOptions {
  /** Maximum number of nodes to include (default: 50) */
  maxNodes?: number;

  /** Maximum number of code blocks to include (default: 10) */
  maxCodeBlocks?: number;

  /** Maximum characters per code block (default: 2000) */
  maxCodeBlockSize?: number;

  /** Whether to include code blocks (default: true) */
  includeCode?: boolean;

  /** Output format (default: 'markdown') */
  format?: 'markdown' | 'json';

  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth from entry points (default: 2) */
  traversalDepth?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;
}

/**
 * Full context for a task, ready for Claude
 */
export interface TaskContext {
  /** The original query/task */
  query: string;

  /** Subgraph of relevant nodes and edges */
  subgraph: Subgraph;

  /** Entry point nodes (from semantic search) */
  entryPoints: Node[];

  /** Code blocks extracted from key nodes */
  codeBlocks: CodeBlock[];

  /** Files involved in this context */
  relatedFiles: string[];

  /** Brief summary of the context */
  summary: string;

  /** Statistics about the context */
  stats: {
    /** Number of nodes included */
    nodeCount: number;
    /** Number of edges included */
    edgeCount: number;
    /** Number of files touched */
    fileCount: number;
    /** Number of code blocks included */
    codeBlockCount: number;
    /** Total characters in code blocks */
    totalCodeSize: number;
  };
}

/**
 * Options for finding relevant context
 */
export interface FindRelevantContextOptions {
  /** Number of semantic search results (default: 5) */
  searchLimit?: number;

  /** Graph traversal depth (default: 2) */
  traversalDepth?: number;

  /** Maximum nodes in result (default: 50) */
  maxNodes?: number;

  /** Minimum semantic similarity score (default: 0.3) */
  minScore?: number;

  /** Edge types to follow in traversal */
  edgeKinds?: EdgeKind[];

  /** Node types to include */
  nodeKinds?: NodeKind[];

  /**
   * Vector-ranked entry points to fold into (or replace) the FTS entry points.
   * Normally left unset — `findRelevantContext` computes these itself from the
   * stored node embeddings when a semantic model is available. Set explicitly
   * only to override that (e.g. the retrieval spike / tests supplying seeds).
   */
  seedResults?: SearchResult[];

  /**
   * How supplied/computed `seedResults` combine with the FTS channels:
   * - `'merge'` (default): hybrid — run FTS *and* fuse the vector seeds by rank.
   * - `'replace'`: vector-only — skip the FTS channels, seeds are the entry points.
   */
  seedMode?: 'replace' | 'merge';
}
