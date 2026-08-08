# Core AST Implementation Reference

This page details the internal design, stage specifications, module layout, and
extension boundaries of `core-ast`.

## Module Layout

```text
src/
├── exceptions.py       # Typed domain exceptions
├── core_ast.py         # Public API re-exports
├── api.py              # Orchestrators (build_endpoint_payload, etc.)
├── models/             # Pydantic DTOs (EndpointDefinition, ASTContext, ExtractedContext, TracerResult, LLMPayload)
├── cte/                # Config: Language patterns (patterns.toml) & constants
├── locator/            # Handler search strategy
├── ast_builder/        # Tree-sitter file parsing
├── extractor/          # Byte-slicing function extraction
├── import_analyzer/    # Import statement parser (Strategy per language)
├── resolver/           # Physical path resolution (Strategy per language)
├── tracer/             # Recursive dependency call graph
├── quality/            # Quality thresholds & fallback planning
└── packager/           # XML serialization, sanitization & token estimation
```

## Detailed Stage reference

### 1. `locator`
Scans the repo while honoring `.gitignore` and skipping tests. Matches `operation_id`
first, falling back to route decorators. Patterns live in `cte/patterns.toml`.
- **Exceptions:** Raises `ControllerNotFoundError` (no matches) or
`AmbiguousControllerError` (includes candidates).
- **Output:** Filepath, match strategy, and confidence score.

### 2. `ast_builder` & `extractor`
- **`ast_builder`:** Reads raw bytes into an `ASTContext` containing the tree, tag query,
and original bytes.
  - **Exceptions:** `UnsupportedLanguageError`, `SyntaxParseError`.
- **`extractor`:** Uses AST byte offsets (`source_bytes[start_byte:end_byte]`) to preserve
exact formatting, comments, and decorators. Returns `ExtractedContext` (code, function name,
source path, line bounds).
  - **Exceptions:** `TargetNodeNotFoundError`.

> **tree-sitter API gotcha:** queries run through `QueryCursor.matches(root_node)`
> (tree-sitter ≥ 0.23). The older `language.query(scm).captures(node)` shape from
> < 0.21 changed its return format across v0.21 → v0.23 → v0.25 — a real trap when
> bumping the `tree-sitter` dependency.

> **Decorators aren't children:** in Python (and other grammars), decorators are
> siblings grouped under a `decorated_definition` node, not children of
> `function_definition`. Without ascending to the parent, byte-slicing would start
> at `def`, dropping the `@decorator` lines. `_include_decorators` checks
> `node.parent.type in DECORATOR_NODE_TYPES` (a `frozenset` in `cte/constants.py`)
> and returns the parent when it applies.

### 3. `import_analyzer`, `resolver`, & `tracer`
- **Import Analysis:** Languages implement strategies to map source imports into `ImportEntry`
records, resolved to physical paths by `resolver`. `filter_relevant_imports` discards unused
modules.
- **Tracer:** Recursively resolves `call_detector` matches until reaching depth limits or
cyclic symbols. Unmapped calls are logged as `unresolved_calls`.

### 4. `quality`
Computes the completion ratio (resolved vs. discovered calls) and enforces quality modes:

| Mode | Condition (`cte/constants.py`) | Shipped Context |
|---|---|---|
| `surgical` | `completion_ratio >= TRACER_THRESHOLD_SURGICAL` (`0.60`) | Controller & exact dependency chain |
| `hybrid` | `TRACER_THRESHOLD_HYBRID <= ratio < 0.60` (`0.25`–`0.60`) | Dependency chain + bounded fallback files |
| `fallback` | `ratio < 0.25` **or** an unresolved call matches `TRACER_CRITICAL_KEYWORDS` | Bounded fallback files only |

The critical-keyword override wins regardless of ratio: an unresolved call named
`verify_token` forces `fallback` even at `completion_ratio == 1.0`. The keyword set
covers auth/permission/payment/transaction terms (`auth`, `verify`, `charge`,
`payment`, `transfer`, …) — anything that looks security- or money-adjacent gets
the safest, most conservative context.

The fallback file bundle (`hybrid`/`fallback` modes) is capped by a hard budget:

| Limit | Default | Purpose |
|---|---|---|
| `TRACER_MAX_FILES` | `10` | Max files added to the bundle. |
| `TRACER_MAX_TOTAL_LINES` | `2000` | Max combined lines across all bundle files. |
| `TRACER_MAX_LINES_PER_FILE` | `500` | Per-file line cap — a 3000-line file still only "costs" 500 against the budget, but ships in full. |

Directories matching `TRACER_EXCLUDE_DIR_PATTERNS` (`tests/`, `vendor/`,
`node_modules/`, `migrations/`, …) never enter the fallback bundle.

### 5. `packager`
Serializes data into an XML-tagged `system_context`. Wraps source code inside `CDATA`,
sanitizes UTF-8 strings, and estimates tokens. Sets `is_partial_context = True` if mode
is non-surgical or unresolved calls exist.

```xml
<source_context>
  <primary_controller filepath="app/orders.py" name="create_order">
    <![CDATA[ ...controller code... ]]>
  </primary_controller>
  <dependencies>
    <dependency filepath="app/validate.py" name="validate"><![CDATA[ ... ]]></dependency>
  </dependencies>
  <missing_context>
    <unresolved_call>charge_card</unresolved_call>
  </missing_context>
</source_context>
```

## Architectural Invariants & Extensions

* **Stateless & Deterministic**: Same input always yields identical outputs or exceptions.
Never executes analyzed source code.
* **Strict Error Handling**: Every failure is a typed domain exception with diagnostic
context. No silent None returns or hidden truncations.

### Extending Languages

Adding a language is a config + strategy change, never a core-dispatch edit:

1. **Locator** — add a `.py`/`.go`/... entry to `cte/patterns.toml`:

    ```toml
    [function_keywords]
    ".ext" = ["keyword1", "keyword2"]   # [] falls back to \bNAME\s*\( universally

    [route_decorators.by_extension]
    ".ext" = 'decorator_template_with_{method}_{METHOD}_{Method}_placeholders'
    ```

2. **`ast_builder`/`extractor`** — add a `.scm` tag-query file for the grammar. Every
   query only needs to populate four standardized captures: `@name`,
   `@definition.function`, `@definition.method`, `@definition.class`. Nothing else
   in the pipeline depends on grammar-specific node names.
3. **`import_analyzer`** — implement `BaseImportAnalyzer.analyze()` for the
   language, register it in `factory.py`.
4. **`resolver`** — implement `BaseModuleResolver.resolve()`, register it via
   `get_resolver`.

No other file changes. `tracer`, `quality`, and `packager` are language-agnostic by
construction — they only consume the DTOs the strategies above produce.

## Formal Invariants

Beyond "stateless & deterministic," each stage holds specific contracts a change
must never break:

| Module | Invariant |
|---|---|
| `locator` | Never prints or prompts; always returns `LocatorResult` or raises a domain exception. |
| `import_analyzer` | `analyze_imports()` always returns `list[ImportEntry]` (never `None`); never raises on an unsupported language; `imported_names` is always a list. |
| `resolver` | `resolve()` never returns a path that doesn't exist on disk; when it returns something, it's always absolute; never raises for an external/library import (returns `None` instead). |
| `tracer` | `expected_calls == resolved_calls + len(unresolved_calls)`, always; `completion_ratio` is always in `[0.0, 1.0]`; `selected_files == []` in `surgical` mode; `dependency_chain == []` in `fallback` mode. |
| `quality` (fallback bundle) | Always includes the controller file if it exists on disk; `selected_files` has no duplicates; `truncation_applied` is `True` iff a file was dropped for budget; nothing from `tests/`, `vendor/`, `node_modules/`, `migrations/` ever appears in the bundle. |

## Development & Testing

Use the Core AST commands in
[Development & Testing](../../getting-started/development.md#module-commands).

Integration-test setup and output conventions are documented separately in
[Integration Tests](integration-tests.md).
