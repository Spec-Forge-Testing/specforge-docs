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

### 3. `import_analyzer`, `resolver`, & `tracer`
- **Import Analysis:** Languages implement strategies to map source imports into `ImportEntry`
records, resolved to physical paths by `resolver`. `filter_relevant_imports` discards unused
modules.
- **Tracer:** Recursively resolves `call_detector` matches until reaching depth limits or
cyclic symbols. Unmapped calls are logged as `unresolved_calls`.

### 4. `quality`
Computes the completion ratio (resolved vs. discovered calls) and enforces quality modes:

| Mode | Condition | Shipped Context |
|---|---|---|
| `surgical` | Complete trace | Controller & exact dependency chain |
| `hybrid` | Partially resolved calls | Dependency chain + bounded fallback files |
| `fallback` | Low ratio OR unresolved critical call (auth, payment) | Bounded fallback files only |

Thresholds and file/token limits are managed under `cte/`.

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
* **Extending Languages**: Implement language-specific analyzer & resolver strategies,
register them in their factories, and add patterns to cte/patterns.toml.
* **Strict Error Handling**: Every failure is a typed domain exception with diagnostic
context. No silent None returns or hidden truncations.

## Development & Testing

Use the Core AST commands in
[Development & Testing](../../getting-started/development.md#module-commands).

Integration-test setup and output conventions are documented separately in
[Integration Tests](integration-tests.md).
