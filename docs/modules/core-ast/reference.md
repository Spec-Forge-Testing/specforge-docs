# Core AST — Reference

This page details the internal design, stage specifications, module layout, and
extension boundaries of `core-ast`.

## Module Layout

```text
src/core_ast/
├── __init__.py         # Public surface
├── api.py              # Orchestrators (analyze_endpoint, analyze_endpoints)
├── exceptions.py       # Typed domain exceptions
├── models/             # Pydantic DTOs that cross stages
├── cte/                # Only what two or more stages share (ADR-004)
├── locator/            # Which file, and which function inside it
├── ast_builder/        # Tree-sitter parsing + .scm tag queries
├── extractor/          # Byte-slicing function extraction
├── import_analyzer/    # Import statement parser (Strategy per language)
├── resolver/           # Physical path resolution (Strategy per language)
├── tracer/             # Recursive dependency call graph
├── quality/            # Mode policy & fallback planning
└── packager/           # XML serialization, sanitization & token estimation
```

Every stage owns its constants (`<stage>/constants.py`); `cte/constants.py` holds
only what two or more stages read. See [ADR-004](adr/foundations.md#adr-004).

## Detailed Stage reference

### 1. `locator`

Answers two questions that are easy to conflate: **which file** serves the endpoint,
and **which function** inside it.

```text
locator/
├── constants.py    # Route vocabulary, exclusions, cache size
├── scanner.py      # Filesystem: candidates, reading, searching by extension
├── patterns.py     # patterns.toml, route shapes, definition regexes
├── matcher.py      # locate_controller — which file
├── handler.py      # resolve_handler_location — which function
└── patterns.toml   # Every per-language rule
```

`patterns.py` is the machinery both consumers share; `matcher` and `handler` do not
import each other. Dependencies run one way: `constants → scanner → patterns →
{matcher, handler}`.

**Which file.** `locate_controller` walks strategies from most to least specific and
returns the first that leaves exactly one candidate, carrying the confidence of the
strategy that hit:

| Strategy | What it found | Confidence |
|---|---|---:|
| `operation_id` | A definition named like the contract's `operationId` | 1.00 |
| `path_decorator` | The whole path, written in a decorator | 0.80 |
| `path_prefixed` | The path with a prefix in front (`/api/tags`) | 0.65 |
| `path_suffix` | Only the tail; the prefix comes from a mount | 0.50 |
| `mount_prefix` | Two hops: the literal prefix in a mount, then the module mounted | 0.45 |
| `class_prefix` | Only the class-level prefix; says nothing about the method | 0.40 |
| `resource_route` | Nothing is written: route and handler both come from convention | 0.35 |

An ambiguous strategy does not abort the cascade — see
[ADR-012](adr/locator.md#adr-012). The last two strategies are documented in
[ADR-010](adr/locator.md#adr-010) and [ADR-011](adr/locator.md#adr-011).

**Which function.** The contract's `operationId` and the function's name in code are
independent conventions — RealWorld declares `GetTags` for a handler called
`get_all_tags` — so `resolve_handler_location` infers it: find the route declaration
and take the definition that follows, with four fallbacks for frameworks that name
the handler inside the declaration or in another file
([ADR-015](adr/locator.md#adr-015), [ADR-016](adr/locator.md#adr-016)).

- **Exceptions:** `ControllerNotFoundError` (nothing matched),
  `AmbiguousControllerError` (carries its candidates), `HandlerNameNotFoundError`
  (file located, function not nameable).
- **Output:** filepath, match strategy, confidence, and optionally the scope or the
  handler name when the strategy produced one.

**Technology choices**

| Choice | Why | Alternative considered | Trade-off |
|---|---|---|---|
| `pathspec` for `.gitignore` | Full gitignore format (globstar, negations) — the de facto Python standard for this. | `fnmatch` (no globstar/negation support); manual parsing (error-prone, costly to maintain) | Small external dependency (<50 KB). |
| `re` (stdlib regex) for the primary heuristic | One O(n) pass per candidate file, no external dependency. | `tree-sitter` for the primary search — more precise, but a full parse per candidate is O(n) parse + O(m) query, expensive on large repos; a `grep` subprocess — OS-dependent, not portable, hard to test | Can false-positive inside strings/comments; tolerable combined with the extension/test-path filter. |
| `tomllib` for pattern config | Stdlib since Python 3.11; no dependency; TOML reads better than JSON for rule config. | — | Requires Python ≥ 3.11. A new language is a `locator/patterns.toml` edit, never a code change. |

**Design principles:** deterministic (same input → same output or exception); fails
with information (`AmbiguousControllerError` carries its candidate list,
`ControllerNotFoundError` carries `path`/`method`); tolerates bad encoding by
skipping the file rather than failing the whole scan; and never guesses between two
candidates, because a confident wrong answer costs more downstream than a miss.

The repository scan **is** cached, per repository and for the life of the process —
it used to be stateless, and stopped being so deliberately
([ADR-002](adr/locator.md#adr-002)). A long-running host must call `clear_scan_cache()`
between runs ([ADR-003](adr/locator.md#adr-003)).

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
> `node.parent.type in DECORATOR_NODE_TYPES` (a `frozenset` in `extractor/constants.py`)
> and returns the parent when it applies.

**Why tree-sitter.** An incremental, deterministic, multi-language parser
(100+ grammars) — the industry standard for lightweight static analysis
(GitHub, Neovim, Helix, VS Code). Alternatives considered: Python's own `ast`
(Python-only), `libCST` (Python-only, higher overhead preserving formatting),
`ANTLR` (per-language parser generation, costly setup), `pygments` (tokenizes
only, no semantic tree). One API for every language is worth tree-sitter's own
churn — see the `QueryCursor` gotcha above.

**Why a Golden Path of 11 languages (+ TSX) instead of "all of them."** ~95% of
backend APIs are Python, JS/TS, Go, Java, C#, Ruby, PHP, Rust, Kotlin or Swift.
A fixed high-coverage set keeps the distribution light and the test surface
manageable; a repo outside it gets `UnsupportedLanguageError` and the
orchestrator's plain-text fallback. Seven of the eleven (Java, C#, Ruby, PHP,
Rust, Kotlin, Swift) load dynamically via `importlib.import_module` under the
`golden-path` extra, so installing without them stays lightweight — at the cost
of a runtime error if a dynamic grammar is used without the package installed.

**Why `.scm` query files instead of inline logic.** tree-sitter's own
declarative query DSL externalizes "what to capture" from "how each grammar is
shaped." Every stage downstream depends only on the four standardized captures
above, so a new language is one `.scm` file, not a code change. Trade-off: the
DSL has a learning curve and no compile-time error messages.

### 3. `import_analyzer`, `resolver`, & `tracer`
- **Import Analysis:** Languages implement strategies to map source imports into `ImportEntry`
records, resolved to physical paths by `resolver`. `filter_relevant_imports` discards unused
modules.
- **Tracer:** Recursively resolves `call_detector` matches until reaching depth limits or
cyclic symbols. Unmapped calls are logged as `unresolved_calls`.

**How the twelve grammars describe a call.** The detector has to recognise one
idea across twelve syntaxes, and they disagree on two axes at once.

*Where the called name sits* — three arrangements, which are the three branches
of `_callee_node`:

| Arrangement | Languages |
| --- | --- |
| The call node carries the name itself | Java, Ruby, PHP |
| A `function` field points at it | Python, JS/TS, Go, Rust, C# |
| It is the first named child, with no field | Kotlin, Swift |

*How a qualified call is spelled* — `obj.method`, `pkg::func`, `receiver->name`.
The detector normalises all of them to a single dotted form and keeps only the
last segment of the base, because that is the segment naming the module (see
[ADR-026](adr/tracer.md#adr-026)).

None of this lives in control flow: every shape above is an entry in a table in
`tracer/constants.py`, and adding a language means adding entries
([ADR-025](adr/tracer.md#adr-025)).

**Design decisions — `import_analyzer`.** Each language gets its own
`BaseImportAnalyzer` subclass (Strategy pattern), so the engine never branches on
language. Six of the twelve share one more layer: Java, C#, Kotlin, Swift, Rust
and PHP all write `<keyword> a.b.c`, so they are declared over
`DeclarativeImportAnalyzer` as four class attributes — which node is the
statement, which child holds the path, the segment separator, what to strip —
instead of reimplementing the walk. Python, TypeScript, Go and Ruby have their
own, because their grammars split the statement differently. Analyzers walk the tree manually rather than through `.scm` queries —
import syntax varies too much per grammar (`import_from_statement` in Python vs.
`import_declaration` in Go vs. a `require` call in Ruby) for one declarative
capture set to cover cleanly. `get_analyzer()` returns `None` for an unsupported
language instead of raising — a softer failure than the resolver's, since a file
whose imports can't be read is simply traced no further, it doesn't abort the
analysis. Analyzer instances are stateless singletons.

**Design decisions — `resolver`.** Same Strategy shape, one `BaseModuleResolver`
subclass per language. `resolve()` returns `Path | None` rather than raising for
"not found on disk" — the normal case for external/library imports;
`UnresolvableDependencyError` is reserved for a language with no resolver
registered at all, chosen over the original spec's `exit(1)` so the engine can
record the call as unresolved and keep going instead of killing the process.
Every resolver tries multiple search roots (repo root, `src/`, the source file's
own directory) instead of requiring manual path configuration.

**Resolver special cases by language**

| Language | Special case | Handling |
|---|---|---|
| Python | Packages with `__init__.py` | Tries `pkg/__init__.py` if `pkg.py` doesn't exist. |
| Python | Relative imports (`from .. import x`) | Walks up `level - 1` directories from the source file. |
| TypeScript/JS | Multiple extensions | Tries `.ts`, `.tsx`, `.js`, `.jsx` in order. |
| TypeScript/JS | Index files | Tries `dir/index.ts`, `dir/index.js` as a package façade. |
| Go | Directory-based resolution | Returns the package directory; the engine finds the file with the target function. |
| Java | Dotted notation | `com.example.Service` → `com/example/Service.java`. |
| Rust | Module prefixes | Strips `crate::`, `self::`, `super::` before resolving. |
| Rust | `mod.rs` | Tries `module/mod.rs` as an alternative to `module.rs`. |
| Ruby | `require_relative` | Marks `is_relative=True`, resolves from the source file's directory. |

**Design decisions — `tracer`.** `call_detector` re-parses each function's
snippet in isolation rather than reusing the whole-file tree, so detected calls
never leak scope from surrounding code. Node-type dispatch uses a `dict`
(`_NODE_EXTRACTORS`) instead of an `if`/`elif` chain, so a new AST node type for
a call site is one dict entry, not a new branch. `engine.py` prevents cycles
with a `visited_nodes: set[str]` keyed `"{filepath}::{function_name}"`, shared
by reference across the whole recursion (O(1) per check); `max_depth=15` is a
secondary safeguard for pathological non-cyclic depth (long wrapper chains).
`_filter_traceable_calls` treats a call as a builtin to skip unless it's
explicitly imported or defined locally in the same file, so a user's own `map`
or `sum` still gets traced.

**Cross-language qualified-call resolution.** A qualified call (`obj.method()`)
is only traced when its base is an import that already resolved to a file
**inside** `repo_root`. That single rule is what makes `self.compute()` or
`svc.charge()` — where the base is a parameter or a local variable, not an
import — drop out without a special case, and it's why the tracer never
chases the language's own stdlib or a third-party library.

The twelve grammars express one idea — a call, with or without a base — in
nine different shapes, so resolution goes through tables of node types and
field names rather than a branch per language. The call node either carries
the name itself (Java `method_invocation`, Ruby `call`, PHP
`scoped_call_expression`), points at it with a `function` field (Python,
JS/TS, Go, Rust, C#, PHP), or leaves it as the first named child with no field
at all (Kotlin, Swift). A multi-segment base resolves to its last segment —
the module that actually names the function:

| Source | Detected as |
|---|---|
| `services.process()` (Python, JS/TS) | `services.process` |
| `services.Process()` (Go) | `services.Process` |
| `crate::services::process()` (Rust) | `services.process` |
| `import a.b; a.b.c()` | `b.c` |
| `obj.method().chained()`, `self::helper()` | dropped — no module to attribute it to |

The snippet is re-parsed on its own, outside its file, and not every language
recognizes its own code that way: a bare PHP function parses as a single text
node, so languages that need an opening marker get one prepended before
parsing.

`ImportEntry.imported_names` holds the name the **code** uses — the alias
when there is one — because that's what has to match the call.
`ImportEntry.aliases` keeps the original name next to it, because that's the
name the function is defined under in the target file. Storing only one of
the two would silently lose `import services as svc; svc.process()`.

Imports are split three ways by whether they resolve inside the repository:

| Import | Treated as |
|---|---|
| Resolves inside `repo_root` | Traced. |
| **Relative** and doesn't resolve | A broken local dependency — counted in `unresolved_calls`. |
| **Absolute** and doesn't resolve | `external_calls` — recorded, not traced, not counted. |

The relative case admits no third-party reading: if `from .config import
config` doesn't resolve, something local is missing, and the abort policy
must see it. An absolute one is ambiguous — `requests` and a mistyped local
module look identical — so it's neither traced nor counted against the
ratio, but it's listed rather than dropped silently.

An import doesn't always resolve to a *file*: a Go package, a Python package
with an `__init__.py`, a Rust module with a `mod.rs`, and a Swift module all
resolve to a **directory**, because no single file represents them. The
fallback bundle expands those into their source files, entry file first so
it's the last to go when the budget cuts.

Resolving costs I/O, so the import scan keeps the resolved `Path` next to
each relevant import and the fallback bundle consumes those paths directly
instead of re-deriving them — the heuristic it used before only knew about
`.py .ts .js .tsx .go .java`, so in eight of the twelve languages the bundle
silently contained no direct imports at all.

### 4. `quality`
Computes the completion ratio (resolved vs. discovered calls) and enforces quality modes:

| Mode | Condition (`quality/constants.py`) | Shipped Context |
|---|---|---|
| `surgical` | `completion_ratio >= THRESHOLD_SURGICAL` (`0.60`) | Controller & exact dependency chain |
| `hybrid` | `THRESHOLD_HYBRID <= ratio < 0.60` (`0.25`–`0.60`) | Dependency chain + bounded fallback files |
| `fallback` | `ratio < 0.25` **or** an unresolved call matches `CRITICAL_KEYWORDS` | Bounded fallback files only |

The critical-keyword override wins regardless of ratio: an unresolved call named
`verify_token` forces `fallback` even at `completion_ratio == 1.0`. The keyword set
covers auth/permission/payment/transaction terms (`auth`, `verify`, `charge`,
`payment`, `transfer`, …) — anything that looks security- or money-adjacent gets
the safest, most conservative context.

The fallback file bundle (`hybrid`/`fallback` modes) is capped by a hard budget:

| Limit | Default | Purpose |
|---|---|---|
| `MAX_FILES` | `10` | Max files added to the bundle. |
| `MAX_TOTAL_LINES` | `2000` | Max combined lines across all bundle files. |
| `MAX_LINES_PER_FILE` | `500` | Per-file line cap — a 3000-line file still only "costs" 500 against the budget, but ships in full. |

Directories matching `EXCLUDE_DIR_PATTERNS` (`tests/`, `vendor/`,
`node_modules/`, `migrations/`, …) never enter the fallback bundle.

**Why pure functions for the mode decision.** `policy.py` holds no state and
does no I/O — `compute_completion_ratio`, `detect_forced_abort` and
`decide_mode` are the part of the system most likely to change (threshold
tuning, new critical keywords), so keeping them pure keeps that tuning cheap to
test and change without touching anything else. Critical keywords live in
its stage's `constants.py`, not inline, for the same reason.

**Fallback bundle priority (`fallback_planner.py`):** 1) the controller file,
always first; 2) direct local import targets; 3) files that mention an
unresolved call by name. `_shallow_scan` bounds the repo walk to a few
directory levels instead of a full `os.walk`, so scanning a huge monorepo stays
cheap; `_is_excluded` filters case-insensitively.

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

1. **Locator** — add a `.py`/`.go`/... entry to `locator/patterns.toml`:

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

### Other extension points

| To add | Change |
|---|---|
| A new AST node type for call detection | One entry in `_NODE_EXTRACTORS` (`tracer/call_detector.py`). |
| A new critical keyword | One entry in `CRITICAL_KEYWORDS` (`quality/constants.py`). |
| A new excluded directory for the fallback bundle | One entry in `EXCLUDE_DIR_PATTERNS` (`quality/constants.py`). |
| Different surgical/hybrid thresholds | `THRESHOLD_SURGICAL` / `THRESHOLD_HYBRID` (`quality/constants.py`). |

### Not implemented: search by line coordinate

`extractor` only searches by name (`target_identifier`). Line-coordinate search
was in scope on paper but no current consumer needs it — the tracer always
operates by name. `extract_function_at_line(ast_context, line_number)` can be
added later without breaking the existing interface.

## Cross-cutting conventions

- **Domain exceptions only.** Every stage raises exceptions defined in
  `core_ast/exceptions.py`; a raw `FileNotFoundError` or `NotADirectoryError`
  never crosses a module boundary, so the orchestrator can catch one exception
  hierarchy instead of Python's.
- **Constants centralized, never duplicated.** Shared knowledge
  (`quality/constants.py`) — critical keywords, thresholds, excluded directories,
  decorator node types — has exactly one owner; no module redefines what
  another needs.
- **Pydantic v2 at every boundary.** Every DTO crossing a stage boundary
  (`EndpointDefinition`, `LocatorResult`, `ASTContext`, `ExtractedContext`,
  `TracerResult`, `LLMPayload`) is a validated Pydantic model, giving runtime
  type-checking and free serialization for logging/debugging.

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
[Contributing & Testing](../../developer-guide/contributing.md#test-a-compose-module).

Integration-test setup and output conventions are documented separately in
[Integration Tests](integration-tests.md).
