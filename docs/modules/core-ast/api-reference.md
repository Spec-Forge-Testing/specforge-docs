# Core AST — API reference

Function-level reference for `locator`, `ast_builder`, `extractor`, `import_analyzer`,
`resolver`, `tracer`, `quality` and `packager`. For the *why* behind these shapes —
technology choices, trade-offs, invariants — see the [Implementation Reference](reference.md).

Recommended entry point:

- `core_ast.build_endpoint_payload(endpoint, repo_root, parser_manager=None) -> LLMPayload`
  — the typed, XML-tagged context bundle the inference engine consumes.
- `core_ast.build_endpoint_code_bundle(...) -> str` returns the payload's `system_context`
  (kept for string consumers); `core_ast.export_endpoint_bundle(...)` remains as a reexport.

---

## `locator`

**Purpose:** given an endpoint from the OpenAPI contract, locate the physical file in
the repository where its controller is implemented.

| File | Responsibility |
|---|---|
| `locator/scanner.py` | Filesystem crawl with filters |
| `locator/matcher.py` | Search heuristics and the public function |

### `scanner.py`

#### `scan_repository(repo_root: Path) -> list[Path]`

Public. Returns every valid source file in the repository.

**Filter pipeline:** validates `repo_root` exists and is a directory (raises
`RepositoryNotFoundError` / `RepositoryNotADirectoryError`) → loads `.gitignore` via
`pathspec` → `Path.rglob("*")` → filters by supported extension
(`EXTENSION_TO_LANGUAGE.keys()`) → excludes test paths (`_is_test_path`) → returns a
sorted list of absolute paths.

`.gitignore` encoding errors are silenced; the scan continues without that filter.

#### `_load_gitignore(repo_root: Path) -> pathspec.PathSpec | None`

Returns a compiled `PathSpec`, or `None` if the file doesn't exist or fails to decode
(silent fail).

#### `_is_test_path(path: Path) -> bool`

True if a parent directory matches `TEST_DIR_PATTERNS` (`tests`, `spec`, …) or the
filename matches `TEST_FILE_PATTERNS` (`test_`, `.spec.`, …). Both live in
`cte/constants.py`.

### `matcher.py`

#### `locate_controller(repo_root: Path | str, endpoint_def: EndpointDefinition) -> LocatorResult`

**Main public function.** Implements the cascade heuristic.

```python
from core_ast.locator.matcher import locate_controller
from core_ast.models.locator import EndpointDefinition

endpoint = EndpointDefinition(path="/api/users", method="post", operation_id="create_user")
result = locate_controller("/path/to/repo", endpoint)
# result.filepath       -> Path("/path/to/repo/src/routes/users.py")
# result.match_strategy -> "operation_id"
# result.confidence     -> 1.0
```

**Cascade:**

1. **Primary** (`operation_id`): builds a regex from language keywords (TOML),
   searches for the function signature. `confidence=1.0`.
2. **Secondary** (route decorator): builds a regex from decorator templates (TOML),
   searches for `@app.post("/path")` or equivalent. `confidence=0.8`.

**Raises:** `ControllerNotFoundError` (no file matches), `AmbiguousControllerError`
(more than one match, includes the candidate list), or `RepositoryNotFoundError` /
`RepositoryNotADirectoryError` delegated from `scan_repository`.

#### `_build_operation_id_pattern(operation_id: str) -> re.Pattern`

Combined regex to detect the function signature in any Golden Path language. For
languages with keywords (`def`, `func`, `function`): `(?:keyword)\s+NAME\b`. For
languages without one (Java, C#): `\bNAME\s*\(`. Keywords come from
`cte/patterns.toml → [function_keywords]`.

#### `_build_decorator_pattern(path: str, method: str) -> re.Pattern`

Regex for route decorators (`@app.post`, `@GetMapping`, …). Templates come from
`cte/patterns.toml → [route_decorators.by_extension]`, interpolating `{method}`,
`{METHOD}`, `{Method}`.

#### `_search_in_files(files: list[Path], pattern: re.Pattern) -> list[Path]`

Searches the pattern across candidate files. Files raising `UnicodeDecodeError` or
`OSError` are skipped silently.

### Data models (`models/locator.py`)

```python
class EndpointDefinition(BaseModel):
    path: str  # "/api/users/{id}"
    method: str  # "get", "post", ...
    operation_id: str | None
    parameters: list | None
    request_body: dict | None
    responses: dict | None


class LocatorResult(BaseModel):
    filepath: Path
    match_strategy: str  # "operation_id" | "path_decorator"
    confidence: float  # 1.0 | 0.8
```

---

## `ast_builder`

**Purpose:** given a source file, parse it with tree-sitter and return an `ASTContext`
with the tree, the compiled query, and the original bytes.

| File | Responsibility |
|---|---|
| `ast_builder/engine.py` | Grammar loading, parser/language caching |
| `ast_builder/manager.py` | Public interface, `.scm` query loading, `ASTContext` assembly |
| `ast_builder/tags/*.scm` | Per-language tree-sitter queries |

### `engine.py` — `LanguageEngine`

`ParserManager` **inherits** from this, so every method below is available directly
on the manager.

- `get_language(language_name: str) -> tree_sitter.Language` — returns (or creates and
  caches) the `Language` object. Core languages (Python, JS, TS, TSX, Go) import
  directly; dynamic ones (Java, C#, Ruby, PHP, Rust, Kotlin, Swift) load via
  `importlib.import_module` on demand. Raises `UnsupportedLanguageError` if not
  installed.
- `get_parser(language_name: str) -> tree_sitter.Parser` — cached, built on
  `get_language`.
- `parse(language_name: str, source_code: bytes) -> tree_sitter.Tree`.
- Properties: `engine.supported_languages`, `engine.supported_extensions`.

### `manager.py` — `ParserManager`

Public façade of the module. Extends `LanguageEngine` with the `.scm` query layer and
`ASTContext` assembly (extension, not composition — no per-method re-export needed).

`.scm` queries compile once per language and are cached on the instance: compiling
costs ~8.7 ms, and `build_context` runs once per dependency file during recursive
tracing.

#### `build_context(filepath: Path) -> ASTContext`

**Main public function of `ast_builder`.**

```python
from core_ast.ast_builder.manager import ParserManager

manager = ParserManager()
ctx = manager.build_context(Path("src/routes/users.py"))
# ctx.filepath, ctx.language_name, ctx.source_bytes, ctx.tree, ctx.tag_query
```

**Flow:** detect language by extension (`UnsupportedLanguageError` if outside the
Golden Path) → read the file as bytes → parse with tree-sitter → validate the AST
root isn't `ERROR` (`SyntaxParseError` otherwise) → load and compile the `.scm` query
(`MissingQueryTemplateError` if the file is missing) → return the assembled
`ASTContext`.

**Raises:** `UnsupportedLanguageError`, `FileNotFoundError`, `SyntaxParseError`,
`MissingQueryTemplateError`.

### Tags (`.scm`)

Captures: `@name`, `@definition.function`, `@definition.method`, `@definition.class`.
Languages with all three: Python, Kotlin, Rust, Swift, TypeScript, Go, Java, C#,
Ruby, PHP, JavaScript.

### Data model

```python
class ASTContext(BaseModel):
    filepath: Path
    source_bytes: bytes
    language_name: str
    tree: tree_sitter.Tree
    tag_query: tree_sitter.Query
```

---

## `extractor`

**Purpose:** given an `ASTContext` and a function name, extract the exact code block
(including decorators) via byte-slicing over the AST.

`extractor/function.py` holds the whole module.

#### `extract_function(ast_context: ASTContext, target_identifier: str) -> ExtractedContext`

**Main public function.**

```python
from core_ast.extractor.function import extract_function

result = extract_function(ctx, "create_user")
# result.function_name -> "create_user"
# result.raw_code      -> "def create_user(name):\n    return name\n"
# result.start_line    -> 3   (0-indexed)
# result.end_line      -> 4
```

**Flow:** `tree_sitter.QueryCursor(tag_query).matches(root_node)` iterates every
query match → filters the match whose `@name` equals `target_identifier` → extracts
the `@definition.function` / `@definition.method` / `@definition.class` node (falls
back to `name_node.parent` if none captured) → `_include_decorators` ascends to the
parent if it's a `decorated_definition` → byte-slices `source_bytes[start_byte:end_byte]`
→ decodes to UTF-8.

**Raises:** `TargetNodeNotFoundError`.

#### `_find_target_in_matches(ast_context, target_identifier) -> tuple | None`

Returns `(name_node, definition_node)` for the first name match, or `None`.

#### `_include_decorators(node) -> Node`

Returns `node.parent` if its type is `decorated_definition` or `decorator`,
otherwise the node unchanged — so `@app.post("/users")` stays part of the extracted
`raw_code`.

### Data model

```python
class ExtractedContext(BaseModel):
    function_name: str
    raw_code: str  # exact code, decorators included
    start_line: int  # 0-indexed
    end_line: int  # 0-indexed
```

---

## `import_analyzer`

**Purpose:** parse a source file's import statements into a normalized list of
`ImportEntry`. Strategy pattern: one analyzer subclass per language, all sharing
`BaseImportAnalyzer`.

| File | Responsibility |
|---|---|
| `import_analyzer/base.py` | `BaseImportAnalyzer` ABC, shared `_decode` helper |
| `import_analyzer/factory.py` | `get_analyzer(language_name)` — per-language singletons |
| `import_analyzer/__init__.py` | Public `analyze_imports(ast_context)` |
| `PythonImportAnalyzer` | `from x import y`, `import x`, relative imports |
| `TypeScriptImportAnalyzer` | `import { x } from 'y'`, `import * as x`, `require()` |
| `GoImportAnalyzer` | `import "pkg"`, `import ( "a" "b" )` |
| `RubyImportAnalyzer` | `require 'mod'`, `require_relative './mod'` |
| `DeclarativeImportAnalyzer` | Java, C#, Kotlin, Swift, Rust, PHP (shared algorithm, see below) |

The six `declarative.py` languages share one algorithm (find the statement, decode
the path node, keep the last segment) and only differ in three declared fields
(`STATEMENT_TYPES`, `PATH_TYPES`, and optionally `SEPARATOR`/`STRIP_CHARS`). Adding a
language from that family requires no new logic.

### `base.py`

```python
class BaseImportAnalyzer(ABC):
    @abstractmethod
    def analyze(self, tree, source_bytes) -> list[ImportEntry]: ...

    @staticmethod
    def _decode(node, source_bytes) -> str:
        return source_bytes[node.start_byte : node.end_byte].decode("utf-8")
```

### `factory.py`

#### `get_analyzer(language_name: str) -> BaseImportAnalyzer | None`

```python
from core_ast.import_analyzer.factory import get_analyzer

get_analyzer("python")  # PythonImportAnalyzer singleton
get_analyzer("cobol")   # None — never raises
```

12 languages are mapped (`javascript` and `tsx` share `TypeScriptImportAnalyzer`).

### `__init__.py`

#### `analyze_imports(ast_context: ASTContext) -> list[ImportEntry]`

**Main public function.** Delegates to `get_analyzer`; returns `[]` for an
unsupported language instead of raising.

```python
from core_ast.import_analyzer import analyze_imports

imports = analyze_imports(ast_context)
# [{module_path: "services.payment", imported_names: ["process_payment"], ...}, ...]
```

### `filtering.py` — `filter_relevant_imports`

`filter_relevant_imports(ast_context, extracted_context, repo_root)` narrows the
import list to what the snippet actually references, so the tracer doesn't try to
resolve the controller file's entire import tree — which previously produced
oversized fallback bundles.

**Flow:** `analyze_imports(ast_context)` for the full list → build the set of
identifiers used in `extracted_context.raw_code` (a `call_detector`-style heuristic,
but at name-usage level) → return
`(filtered_imports, blocked_external_names)`, where `filtered_imports` only exports
names used in the snippet and `blocked_external_names` helps
`engine._filter_traceable_calls` decide what to treat as a builtin.

It's a textual heuristic and can misfire on aliases or dynamic reflection — a
discarded-but-relevant import then shows up as `unresolved` in the tracer, and
`quality` plans a fallback to cover it.

### `analyzers.py` — `PythonImportAnalyzer`

| Method | AST node | Example |
|---|---|---|
| `_parse_from_import` | `import_from_statement` | `from services.payment import process, refund` |
| `_parse_plain_import` | `import_statement` | `import os`, `import numpy as np` |

Relative imports: detects leading `.` nodes and sets `relative_level` (dot count) and
`is_relative=True`.

### Data model

```python
@dataclass(frozen=True)
class ImportEntry:
    module_path: str  # "services.payment" | "./utils" | "net/http"
    imported_names: list
    is_relative: bool = False
    relative_level: int = 0
```

---

## `resolver`

**Purpose:** translate an `ImportEntry` into a physical `Path`. Strategy pattern, one
`BaseModuleResolver` subclass per language.

| File | Responsibility |
|---|---|
| `resolver/base.py` | `BaseModuleResolver` ABC |
| `resolver/factory.py` | `get_resolver(language_name)` |
| `PythonResolver` / `TypeScriptResolver` / `GoResolver` / `RubyResolver` / `RustResolver` / `PhpResolver` / `SwiftResolver` | Per-language resolution |
| `DottedPathResolver` | Java, C#, Kotlin — dot-to-slash translation, see below |

Java, C# and Kotlin translate a logical path to a physical one identically save for
extension and ecosystem layout, so they subclass `DottedPathResolver` and only
declare `EXTENSION` and `SEARCH_SUBDIRS`. `resolver/base.py`'s `search_roots` helper
centralizes "repo root + whichever conventional subdirectories exist," previously
copy-pasted into every strategy.

### `base.py`

```python
class BaseModuleResolver(ABC):
    @abstractmethod
    def resolve(
        self, import_entry: ImportEntry, source_filepath: Path, repo_root: Path
    ) -> Path | None: ...
```

**Contract:** absolute `Path` if found on disk; `None` if the import doesn't exist
locally (external/library); `UnresolvableDependencyError` only for unrecoverable
errors.

### `factory.py`

#### `get_resolver(language_name: str) -> BaseModuleResolver`

```python
from core_ast.resolver.factory import get_resolver

get_resolver("python")      # PythonResolver singleton
get_resolver("brainfuck")   # -> UnresolvableDependencyError
```

### `strategies.py` — `PythonResolver`

`resolve()` dispatches to `_resolve_relative()` or `_resolve_absolute()` based on
`import_entry.is_relative`.

- `_resolve_absolute`: `"services.payment"` → `"services/payment"`; tries each search
  root (`repo_root`, `repo_root/src`, the source file's directory) for
  `{root}/{module}.py` then `{root}/{module}/__init__.py` (returns the directory).
- `_resolve_relative`: walks up `relative_level - 1` directories from
  `source_filepath.parent`, then looks for `{base}/{clean_module}.py`.

See the "Design decisions — `resolver`" section of the
[Implementation Reference](reference.md) for the other nine languages' special cases.

---

## `tracer`

**Purpose:** orchestrate the recursive dependency trace. Given an `ExtractedContext`
(entry function), recursively expand the call graph, resolving both local and
imported calls, producing a `TracerResult` with the abort policy applied.

| File | Responsibility |
|---|---|
| `tracer/call_detector.py` | Detects called functions in a snippet |
| `tracer/engine.py` | Recursive orchestrator — public `trace_dependencies` |

### `call_detector.py`

#### `detect_calls(ast_context, extracted_context, parser_manager) -> list[str]`

**Public.** Re-parses the function snippet and returns every function name it calls.

```python
from core_ast.tracer.call_detector import detect_calls

detect_calls(ast_ctx, extracted_ctx, manager)
# ["process_payment", "validate_input"]  — deduplicated, sorted
```

**Flow:** `extracted_context.raw_code.encode("utf-8")` → `parser_manager.parse(...)`
on the snippet alone → `_extract_call_names_from_tree()` walks the tree looking for
`call` / `call_expression` nodes.

#### `_extract_name(node, source_bytes, calls) -> None`

Dispatch dict over `node.type`:

```python
_NODE_EXTRACTORS: dict[str, _NodeExtractor] = {
    "identifier": _extract_identifier,
    "field_identifier": _extract_identifier,
    "attribute": _extract_attribute,
    "member_expression": _extract_attribute,
    "selector_expression": _extract_selector,  # Go
    "scoped_identifier": _extract_scoped,      # Rust
}
```

Adding a new node type is one dict entry.

### `engine.py`

#### `trace_dependencies(extracted_context, ast_context, repo_root, parser_manager, visited_nodes=None, max_depth=15) -> TracerResult`

**Main public function.**

```python
from core_ast.tracer.engine import trace_dependencies

result = trace_dependencies(
    extracted_context=handler_extracted,
    ast_context=controller_ctx,
    repo_root=Path("."),
    parser_manager=manager,
)
# result.mode, result.completion_ratio, result.dependency_chain,
# result.unresolved_calls, result.selected_files
```

**Flow:** `_recursive_trace()` builds a `DependencyContext` → compute
`expected = resolved + unresolved` → `decide_mode(...)` → assemble `TracerResult`
(calls `build_fallback_bundle` in hybrid/fallback modes).

#### `_filter_traceable_calls(call_names, ast_context, imports) -> list[str]`

| Rule | Condition | Action |
|---|---|---|
| 1 | Not in `blocked` (language builtins) | Trace |
| 2 | In the file's explicit imports | Trace (override) |
| 3 | Has a local definition in the file | Trace (override) |
| 4 | None of the above | Skip |

#### `_find_file_in_directory(directory, function_name, language_name) -> Path | None`

For a directory result (Go package, Python package), scans files with the
language's extension for one that contains `function_name` as text; returns the
first match or `None`.

### Data model

```python
class TracerResult(BaseModel):
    mode: Literal["surgical", "hybrid", "fallback"]
    completion_ratio: float  # 0.0-1.0
    expected_calls: int
    resolved_calls: int
    unresolved_calls: list[str] = []
    forced_abort_reason: str | None
    dependency_chain: list[ExtractedContext] = []
    selected_files: list[Path] = []
    truncation_applied: bool = False
```

**Invariant:** `expected_calls == resolved_calls + len(unresolved_calls)`.

---

## `quality`

**Purpose:** decide whether the surgical trace was good enough (mode policy) and
build the alternative context bundle when it wasn't.

| File | Responsibility |
|---|---|
| `quality/policy.py` | Pure mode-decision functions |
| `quality/fallback_planner.py` | Bounded fallback file bundle |

### `policy.py`

```python
def compute_completion_ratio(expected_calls: int, resolved_calls: int) -> float:
    if expected_calls == 0:
        return 1.0
    return min(resolved_calls / expected_calls, 1.0)
```

#### `detect_forced_abort(unresolved_calls: list[str]) -> str | None`

Returns a reason string if any unresolved call contains a
`TRACER_CRITICAL_KEYWORDS` term (`"auth"`, `"payment"`, `"verify"`, `"fraud"`, …), or
`None` otherwise.

#### `decide_mode(expected_calls, resolved_calls, unresolved_calls) -> tuple[str, float, str | None]`

```python
mode, ratio, reason = decide_mode(10, 7, ["missing_func"])
# mode = "surgical"  (ratio=0.7 >= 0.67, no critical function missing)
```

**Logic:** compute the ratio → if `detect_forced_abort` fires, `("fallback", ratio, reason)`
regardless of ratio → else `ratio >= 0.67` → `"surgical"`; `ratio >= 0.33` →
`"hybrid"`; else `"fallback"`. Thresholds are
`TRACER_THRESHOLD_SURGICAL` / `TRACER_THRESHOLD_HYBRID` in `cte/constants.py`.

### `fallback_planner.py`

#### `build_fallback_bundle(controller_path, imports, unresolved_calls, repo_root, max_files, max_total_lines, max_lines_per_file) -> tuple[list[Path], bool]`

```python
from core_ast.quality.fallback_planner import build_fallback_bundle

files, truncated = build_fallback_bundle(
    controller_path=Path("app/ctrl.py"),
    imports=imports,
    unresolved_calls=["verify_token"],
    repo_root=Path("."),
)
```

**Priority:** 1) controller file (always first); 2) `_resolve_import_paths()` —
direct local imports; 3) `_find_candidates_for_unresolved()` — files mentioning an
unresolved call.

**Hard budget** (defaults in `cte/constants.py`): `TRACER_MAX_FILES = 10`,
`TRACER_MAX_TOTAL_LINES = 2000`, `TRACER_MAX_LINES_PER_FILE = 500`.

#### `_resolve_import_paths(imports, controller_path, repo_root) -> list[Path]`

Lightweight heuristic (not the language resolvers): relative imports resolve from
`controller_path.parent`; absolute imports are tried as paths relative to the repo
and to the controller's directory; tries extensions `""`, `.py`, `.ts`, `.js`,
`.tsx`, `.go`, `.java`, and `__init__.py` / `index.ts` / `index.js` as package
façades.

---

## `packager`

**Purpose:** turn `ExtractedContext` + `TracerResult` into the boundary object the
inference engine consumes — a single, XML-tagged, size-measured, UTF-8-sanitized
`LLMPayload`.

| File | Responsibility |
|---|---|
| `packager/xml.py` | Pure XML assembly (`render_system_context`, `SelectedFile`) |
| `packager/tokens.py` | `estimate_tokens` — `tiktoken` when installed, character heuristic otherwise |
| `packager/facade.py` | `_sanitize_utf8`, `build_llm_payload` |

### `facade.py`

#### `build_llm_payload(extracted: ExtractedContext, tracer_result: TracerResult) -> LLMPayload`

**Public entry point.**

```python
from core_ast import build_llm_payload

payload = build_llm_payload(extracted, tracer_result)
# payload.system_context, payload.estimated_tokens, payload.is_partial_context
```

**Flow:** reads each `tracer_result.selected_files` (the only I/O — a read error
degrades to `SelectedFile(path, error=...)` rather than raising) → delegates to the
pure `render_system_context` → sanitizes to valid UTF-8 → computes
`estimated_tokens` and `is_partial_context` (`True` when `unresolved_calls` is
non-empty **or** `mode != "surgical"`).

### `xml.py`

#### `render_system_context(*, primary, dependencies, files, unresolved_calls) -> str`

Pure, deterministic, no I/O. See the XML example in the
[Implementation Reference](reference.md). Optional blocks
(`<dependencies>`, `<selected_files>`, `<missing_context>`) are omitted when empty;
source code is wrapped in `CDATA` (a literal `]]>` is split into `]]]]><![CDATA[>`);
attributes use `quoteattr`, free text uses `escape`.

### `tokens.py`

#### `estimate_tokens(text: str) -> int`

Prefers a cached `tiktoken` (`cl100k_base`) encoder; falls back to `len(text) // 4`
when the optional `tokens` extra isn't installed.

### Data model

```python
class LLMPayload(BaseModel):
    system_context: str
    estimated_tokens: int
    is_partial_context: bool
```

Defined in `models/llm_payload.py`, re-exported from `core_ast`.
