# Code Reference — core_ast

Documentación técnica del código para los módulos `locator`, `ast_builder`, `extractor`, `import_analyzer`, `resolver`, `tracer`, `quality` y `packager`.

Recommended entry point:
- `core_ast.build_endpoint_payload(endpoint, repo_root, parser_manager=None) -> LLMPayload`
  — the typed, XML-tagged context bundle the inference engine consumes.
- `core_ast.build_endpoint_code_bundle(...) -> str` returns the payload's `system_context`
  (kept for string consumers); `core_ast.export_endpoint_bundle(...)` remains as a reexport.

---

## Módulo 1 — `locator`

**Propósito:** Dado un endpoint del contrato OpenAPI, localizar el archivo físico en el repositorio donde está implementado su controlador.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `locator/scanner.py` | Crawling del filesystem con filtros |
| `locator/matcher.py` | Heurísticas de búsqueda y función pública |

---

### `scanner.py`

#### `scan_repository(repo_root: Path) -> list[Path]`

Función pública. Devuelve todos los archivos de código fuente válidos del repositorio.

**Pipeline de filtrado:**
1. Valida que `repo_root` existe y es directorio → lanza `RepositoryNotFoundError` o `RepositoryNotADirectoryError`
2. Carga `.gitignore` via `pathspec` → excluye archivos ignorados
3. `Path.rglob("*")` → recorre todo el árbol
4. Filtra por extensiones soportadas (`EXTENSION_TO_LANGUAGE.keys()`)
5. Excluye rutas de testing (`_is_test_path`)
6. Retorna lista ordenada de rutas absolutas

**Raises:**
- `RepositoryNotFoundError` — `repo_root` no existe
- `RepositoryNotADirectoryError` — `repo_root` no es directorio

**Nota:** Errores de encoding en `.gitignore` se silencian; el scan continúa sin filtro gitignore.

---

#### `_load_gitignore(repo_root: Path) -> pathspec.PathSpec | None`

Carga y parsea el `.gitignore` del repositorio.

- Retorna `PathSpec` compilado si existe y es legible
- Retorna `None` si no existe o hay error de encoding (silent fail)

---

#### `_is_test_path(path: Path) -> bool`

Detecta si una ruta corresponde a código de testing.

- Chequea si algún directorio padre está en `TEST_DIR_PATTERNS` (`tests`, `spec`, etc.)
- Chequea si el nombre del archivo contiene algún patrón de `TEST_FILE_PATTERNS` (`test_`, `.spec.`, etc.)

Ambas constantes viven en `cte/constants.py`.

---

### `matcher.py`

#### `locate_controller(repo_root: Path | str, endpoint_def: EndpointDefinition) -> LocatorResult`

**Función pública principal del módulo locator.** Implementa la heurística en cascada.

```python
from core_ast.locator.matcher import locate_controller
from core_ast.models.locator import EndpointDefinition

endpoint = EndpointDefinition(
    path="/api/users",
    method="post",
    operation_id="create_user",
)
result = locate_controller("/path/to/repo", endpoint)
# result.filepath     → Path("/path/to/repo/src/routes/users.py")
# result.match_strategy → "operation_id"
# result.confidence   → 1.0
```

**Heurística en cascada:**

1. **Primaria** (`operation_id`): construye regex a partir de keywords del lenguaje (TOML), busca la firma de la función. `confidence=1.0`
2. **Secundaria** (decorador de ruta): construye regex a partir de templates de decoradores (TOML), busca `@app.post("/path")` o equivalente. `confidence=0.8`

**Raises:**
- `ControllerNotFoundError` — ningún archivo coincide
- `AmbiguousControllerError` — más de un archivo coincide (incluye lista de candidatos)
- `RepositoryNotFoundError` / `RepositoryNotADirectoryError` — delegado desde `scan_repository`

---

#### `_build_operation_id_pattern(operation_id: str) -> re.Pattern`

Construye regex combinada para detectar la firma de la función en cualquier lenguaje del Golden Path.

Para lenguajes con keywords (`def`, `func`, `function`): `(?:keyword)\s+NAME\b`
Para lenguajes sin keyword (Java, C#): `\bNAME\s*\(`

Las keywords se leen de `cte/patterns.toml → [function_keywords]`.

---

#### `_build_decorator_pattern(path: str, method: str) -> re.Pattern`

Construye regex para detectar decoradores de ruta (`@app.post`, `@GetMapping`, etc.).

Los templates se leen de `cte/patterns.toml → [route_decorators.by_extension]`.
Interpola `{method}`, `{METHOD}`, `{Method}` en cada template.

---

#### `_search_in_files(files: list[Path], pattern: re.Pattern) -> list[Path]`

Busca el patrón en la lista de archivos candidatos. Archivos con `UnicodeDecodeError` u `OSError` se saltan silenciosamente.

---

### Modelos de datos (locator)

Definidos en `models/locator.py`:

```python
class EndpointDefinition(BaseModel):
    path: str               # "/api/users/{id}"
    method: str              # "get", "post", ...
    operation_id: str | None
    parameters: list | None
    request_body: dict | None
    responses: dict | None

class LocatorResult(BaseModel):
    filepath: Path
    match_strategy: str      # "operation_id" | "path_decorator"
    confidence: float        # 1.0 | 0.8
```

---

### Tests — locator

```
tests/test_locator/
├── test_scanner.py   → _load_gitignore (5), _is_test_path (12), scan_repository (11)
└── test_matcher.py   → _build_operation_id (11), _build_decorator (7), _search_in_files (6), locate_controller (12)
```

Cobertura: `scanner.py` 95% · `matcher.py` 98%

---

## Módulo 2 — `ast_builder`

**Propósito:** Dado un archivo de código fuente, parsearlo con tree-sitter y devolver un `ASTContext` con el árbol AST, la query compilada y los bytes originales.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `ast_builder/engine.py` | Carga de gramáticas, cache de parsers y languages |
| `ast_builder/manager.py` | Interfaz pública, carga de queries .scm, construcción de ASTContext |
| `ast_builder/tags/*.scm` | Queries tree-sitter por lenguaje |

---

### `engine.py` — `LanguageEngine`

Motor interno de gramáticas. Instanciado automáticamente por `ParserManager`.

#### `get_language(language_name: str) -> tree_sitter.Language`

Retorna (o crea y cachea) el objeto `Language` de tree-sitter para el lenguaje dado.

- Languages del core (Python, JS, TS, TSX, Go): import directo desde paquete instalado
- Languages dinámicos (Java, C#, Ruby, PHP, Rust, Kotlin, Swift): `importlib.import_module` bajo demanda
- Si no está instalado: `UnsupportedLanguageError`

#### `get_parser(language_name: str) -> tree_sitter.Parser`

Retorna (o crea y cachea) el `Parser` para el lenguaje dado. Usa `get_language` internamente.

#### `parse(language_name: str, source_code: bytes) -> tree_sitter.Tree`

Parsea `source_code` y retorna el árbol AST.

#### Properties

```python
engine.supported_languages   # list[str] — todos los lenguajes del Golden Path
engine.supported_extensions  # list[str] — todas las extensiones soportadas
```

---

### `manager.py` — `ParserManager`

Fachada pública del módulo.

#### `build_context(filepath: Path) -> ASTContext`

**Función pública principal del módulo ast_builder.**

```python
from core_ast.ast_builder.manager import ParserManager

manager = ParserManager()
ctx = manager.build_context(Path("src/routes/users.py"))
# ctx.filepath      → Path
# ctx.language_name → "python"
# ctx.source_bytes  → bytes
# ctx.tree          → tree_sitter.Tree
# ctx.tag_query     → tree_sitter.Query
```

**Flujo interno:**
1. Detecta lenguaje por extensión → `UnsupportedLanguageError` si no está en Golden Path
2. Lee el archivo en modo binario (`read_bytes`)
3. Parsea con tree-sitter → `tree_sitter.Tree`
4. Valida que el root del AST no sea `ERROR` → `SyntaxParseError`
5. Carga y compila la query `.scm` → `MissingQueryTemplateError` si falta el archivo
6. Retorna `ASTContext` consolidado

**Raises:**
- `UnsupportedLanguageError` — extensión fuera del Golden Path
- `FileNotFoundError` — archivo no existe
- `SyntaxParseError` — AST irrecuperable
- `MissingQueryTemplateError` — archivo `.scm` faltante (instalación corrupta)

---

### Tags `.scm`

Ubicados en `ast_builder/tags/`. Una query por lenguaje que captura:

| Capture | Significado |
|---|---|
| `@name` | Nombre del símbolo (identificador) |
| `@definition.function` | Función standalone |
| `@definition.method` | Método dentro de clase/impl/struct |
| `@definition.class` | Clase, struct, protocolo, trait |

**Lenguajes con los tres captures:** Python, Kotlin, Rust, Swift, TypeScript, Go, Java, C#, Ruby, PHP, JavaScript.

---

### Modelo de datos (ast_builder)

```python
class ASTContext(BaseModel):
    filepath: Path
    source_bytes: bytes
    language_name: str
    tree: tree_sitter.Tree
    tag_query: tree_sitter.Query
```

---

### Tests — ast_builder

```
tests/test_ast_builder/
└── test_parser_manager.py  → Golden Path (3), supported properties (4),
                              caching (3), parsing (4), dynamic loading (3),
                              MissingQueryTemplateError (2), SyntaxParseError (2),
                              build_context (6)
```

Cobertura: `engine.py` 98% · `manager.py` 100%

---

## Módulo 3 — `extractor`

**Propósito:** Dado un `ASTContext` y el nombre de una función, extraer el bloque exacto de código (incluyendo decoradores) usando byte-slicing sobre el AST.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `extractor/function.py` | Búsqueda en el AST y extracción por byte-slicing |

---

### `function.py`

#### `extract_function(ast_context: ASTContext, target_identifier: str) -> ExtractedContext`

**Función pública principal del módulo extractor.**

```python
from core_ast.extractor.function import extract_function

result = extract_function(ctx, "create_user")
# result.function_name → "create_user"
# result.raw_code      → "def create_user(name):\n    return name\n"
# result.start_line    → 3  (0-indexed)
# result.end_line      → 4
```

**Flujo interno:**
1. `tree_sitter.QueryCursor(tag_query).matches(root_node)` — itera todos los matches de la query
2. Filtra el match cuyo `@name` coincide con `target_identifier`
3. Extrae el nodo `@definition.function`, `@definition.method` o `@definition.class`; si no hay ninguno, usa `name_node.parent` como fallback
4. `_include_decorators`: asciende al nodo padre si es `decorated_definition` o `decorator`
5. Byte-slice: `source_bytes[start_byte:end_byte]`
6. Decodifica a UTF-8 y retorna `ExtractedContext`

**Raises:**
- `TargetNodeNotFoundError` — la función no existe en el archivo

---

#### `_find_target_in_matches(ast_context, target_identifier) -> tuple | None`

Itera los matches de la query y devuelve `(name_node, definition_node)` para el primer match que coincida por nombre. Retorna `None` si no hay coincidencia.

**Fallback**: si el match no contiene ningún capture `@definition.*`, usa `name_node.parent`.

---

#### `_include_decorators(node) -> Node`

Asciende en el AST para incluir decoradores que precedan a la función.

- Si `node.parent.type` es `decorated_definition` o `decorator` → retorna el padre
- Si no → retorna el mismo nodo

Esto garantiza que `@app.post("/users")` quede incluido en el `raw_code` extraído.

---

### Modelo de datos (extractor)

```python
class ExtractedContext(BaseModel):
    function_name: str
    raw_code: str        # código exacto incluyendo decoradores
    start_line: int      # 0-indexed
    end_line: int        # 0-indexed
```

---

### Tests — extractor

```
tests/test_extractor/
└── test_function_extractor.py  → _include_decorators (4), fallback parent (1),
                                  byte-slicing (4), decorators (2),
                                  not-found (2), multi-language (2)
```

Cobertura: `function.py` 100%

---

---

## Módulo 4 — `import_analyzer`

**Propósito:** Parsear las sentencias de import de un archivo fuente y devolver una lista normalizada de `ImportEntry`. Implementa el Patrón Strategy: cada lenguaje tiene su propio analizador, todos comparten la misma interfaz `BaseImportAnalyzer`.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `import_analyzer/base.py` | ABC `BaseImportAnalyzer` + helper `_decode` |
| `import_analyzer/factory.py` | `get_analyzer(language_name)` — singletons por lenguaje |
| `import_analyzer/__init__.py` | Función pública `analyze_imports(ast_context)` |
| `import_analyzer/analyzers/python_analyzer.py` | `from x import y`, `import x`, imports relativos |
| `import_analyzer/analyzers/typescript_analyzer.py` | `import { x } from 'y'`, `import * as x`, `require()` |
| `import_analyzer/analyzers/go_analyzer.py` | `import "pkg"`, `import ( "a" "b" )` |
| `import_analyzer/analyzers/java_analyzer.py` | `import com.example.Class` |
| `import_analyzer/analyzers/csharp_analyzer.py` | `using Namespace.Class` |
| `import_analyzer/analyzers/ruby_analyzer.py` | `require 'mod'`, `require_relative './mod'` |
| `import_analyzer/analyzers/php_analyzer.py` | `use Namespace\Class`, `require`, `include` |
| `import_analyzer/analyzers/rust_analyzer.py` | `use crate::mod::func`, `use self::x` |
| `import_analyzer/analyzers/kotlin_analyzer.py` | `import com.example.Class` |
| `import_analyzer/analyzers/swift_analyzer.py` | `import Module` |

---

### `base.py` — `BaseImportAnalyzer`

```python
class BaseImportAnalyzer(ABC):
    @abstractmethod
    def analyze(self, tree, source_bytes) -> list[ImportEntry]: ...

    @staticmethod
    def _decode(node, source_bytes) -> str:
        return source_bytes[node.start_byte:node.end_byte].decode("utf-8")
```

`_decode` es el helper compartido por todos los analizadores para extraer texto de un nodo AST.

---

### `factory.py` — `get_analyzer`

#### `get_analyzer(language_name: str) -> BaseImportAnalyzer | None`

Retorna la instancia singleton del analizador para el lenguaje dado, o `None` si no está soportado.

```python
from core_ast.import_analyzer.factory import get_analyzer

analyzer = get_analyzer("python")   # PythonImportAnalyzer singleton
analyzer = get_analyzer("cobol")    # None — no lanza excepción
```

El dict interno `_ANALYZERS` mapea 12 lenguajes (incluyendo `javascript` y `tsx` que comparten `TypeScriptImportAnalyzer`).

---

### `__init__.py` — `analyze_imports`

#### `analyze_imports(ast_context: ASTContext) -> list[ImportEntry]`

**Función pública principal del módulo.**

```python
from core_ast.import_analyzer import analyze_imports

imports = analyze_imports(ast_context)
# [{module_path: "services.payment", imported_names: ["process_payment"], ...}, ...]
```

### Filtering — `filter_relevant_imports`

`filter_relevant_imports(ast_context, extracted_context, repo_root)` está implementada
en `import_analyzer/filtering.py` y complementa a `analyze_imports()` con un paso
contextual que reduce los imports a aquellos realmente utilizados por el snippet.

- Llamadas principales:
    - `analyze_imports(ast_context)` → lista completa de `ImportEntry`.
    - extracción de identificadores usados desde `extracted_context.raw_code`.
    - intersección entre `imported_names` y los identificadores usados.
    - retorno: `(filtered_imports, blocked_external_names)`.

Esta función mejora la selectividad del `tracer` y evita que el planner de fallback
incluya archivos no relacionados al controlador. Es una heurística textual y puede
fallar en casos de imports dinámicos o alias complejos; en ese caso el `quality`
generará un fallback para cubrir lo no resuelto.

- Delega a `get_analyzer(ast_context.language_name)`
- Si el lenguaje no está soportado → retorna `[]` (nunca lanza excepción)

---

### `analyzers/python_analyzer.py` — `PythonImportAnalyzer`

Métodos internos:

| Método | Nodo AST | Ejemplo |
|--------|----------|---------|
| `_parse_from_import` | `import_from_statement` | `from services.payment import process, refund` |
| `_parse_plain_import` | `import_statement` | `import os`, `import numpy as np` |

**Imports relativos:** detecta nodos `.` antes del módulo y asigna `relative_level` (número de puntos) e `is_relative=True`.

---

### Modelo de datos (import_analyzer)

```python
@dataclass(frozen=True)
class ImportEntry:
    module_path: str        # "services.payment" | "./utils" | "net/http"
    imported_names: list    # ["process_payment", "refund"]
    is_relative: bool = False
    relative_level: int = 0
```

`frozen=True`: inmutable durante el análisis. Definido en `models/import_entry.py`.

---

### Tests — import_analyzer

```
tests/test_import_analyzer/
├── test_analyzers.py       → Python (8), TypeScript (6), Go (5) — baseline
└── test_all_analyzers.py   → Python (12), TypeScript (8), Go (6), Java (5),
                              CSharp (5), Ruby (6), PHP (5), Rust (6),
                              Kotlin (5), Swift (4), factory (8),
                              API pública (6), ImportEntry model (7)
```

Cobertura objetivo: todos los analizadores ≥ 80%

---

## Módulo 5 — `resolver`

**Propósito:** Traducir un `ImportEntry` (import lógico) a una ruta física (`Path`) en disco. Implementa el Patrón Strategy: cada lenguaje tiene su propio resolver concreto que hereda de `BaseModuleResolver`.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `resolver/base.py` | ABC `BaseModuleResolver` |
| `resolver/factory.py` | `get_resolver(language_name)` |
| `resolver/strategies/python_resolver.py` | Resolución Python (absoluta, relativa, `__init__.py`) |
| `resolver/strategies/typescript_resolver.py` | Resolución TS/JS (extensiones, index files, search roots) |
| `resolver/strategies/go_resolver.py` | Resolución Go (por directorio de paquete) |
| `resolver/strategies/java_resolver.py` | Resolución Java (puntos → barras, `src/main/java`) |
| `resolver/strategies/ruby_resolver.py` | Resolución Ruby (`require`, `require_relative`) |
| `resolver/strategies/rust_resolver.py` | Resolución Rust (`crate::`, `self::`, `mod.rs`) |
| `resolver/strategies/csharp_resolver.py` | Resolución C# (namespaces → rutas) |
| `resolver/strategies/kotlin_resolver.py` | Resolución Kotlin (igual a Java) |
| `resolver/strategies/php_resolver.py` | Resolución PHP (PSR-4, `use Namespace`) |
| `resolver/strategies/swift_resolver.py` | Resolución Swift (módulos por directorio) |

---

### `base.py` — `BaseModuleResolver`

```python
class BaseModuleResolver(ABC):
    @abstractmethod
    def resolve(
        self,
        import_entry: ImportEntry,
        source_filepath: Path,
        repo_root: Path,
    ) -> Path | None: ...
```

**Contrato:**
- Retorna `Path` absoluta si se encuentra el archivo en disco
- Retorna `None` si el import no existe localmente (externo o de librería)
- Lanza `UnresolvableDependencyError` solo para errores irrecuperables

---

### `factory.py` — `get_resolver`

#### `get_resolver(language_name: str) -> BaseModuleResolver`

```python
from core_ast.resolver.factory import get_resolver

resolver = get_resolver("python")       # PythonResolver singleton
resolver = get_resolver("brainfuck")    # → UnresolvableDependencyError
```

**Raises:** `UnresolvableDependencyError` si el lenguaje no tiene resolver registrado.

---

### `strategies/python_resolver.py` — `PythonResolver`

#### `resolve(import_entry, source_filepath, repo_root) -> Path | None`

**Flujo:**
1. Si `import_entry.is_relative` → `_resolve_relative()`
2. Si no → `_resolve_absolute()`

#### `_resolve_absolute(module_path, source_filepath, repo_root)`

- Convierte `"services.payment"` → `"services/payment"`
- Busca en múltiples search roots: `repo_root`, `repo_root/src`, directorio del archivo fuente
- Para cada root prueba:
  1. `{root}/{module}.py` — archivo directo
  2. `{root}/{module}/__init__.py` — paquete (retorna el directorio)

#### `_resolve_relative(module_path, source_filepath, relative_level)`

- Sube `relative_level - 1` directorios desde `source_filepath.parent`
- Busca `{base}/{clean_module}.py`

---

### Tests — resolver

```
tests/test_resolver/
├── test_resolvers.py       → Python absoluto/relativo (8), TS extensiones (6),
│                             Go directorio (4), Java (4), ABC contract (3) — baseline
└── test_all_resolvers.py   → Python (10), TypeScript (8), Go (6), Java (6),
                              Ruby (7), Rust (7), CSharp (4), Kotlin (4),
                              PHP (4), Swift (4), BaseModuleResolver ABC (5),
                              factory (8)
```

Cobertura objetivo: todos los resolvers ≥ 80%

---

## Módulo 6 — `tracer`

**Propósito:** Orquestar el rastreo recursivo de dependencias de una función. Detecta llamadas, resuelve imports, extrae código y recursa, produciendo un `TracerResult` con la política de abortaje aplicada.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `tracer/call_detector.py` | Detecta llamadas a funciones en un snippet |
| `tracer/engine.py` | Orquestador recursivo — función pública `trace_dependencies` |

---

### `call_detector.py`

#### `detect_calls(ast_context, extracted_context, parser_manager) -> list[str]`

**Función pública.** Re-parsea el snippet de la función y retorna los nombres de todas las funciones que invoca.

```python
from core_ast.tracer.call_detector import detect_calls

calls = detect_calls(ast_ctx, extracted_ctx, manager)
# ["process_payment", "validate_input"]  — deduplicado, ordenado
```

**Flujo:**
1. `extracted_context.raw_code.encode("utf-8")` → bytes del snippet
2. `parser_manager.parse(language, bytes)` → árbol AST del snippet
3. `_extract_call_names_from_tree()` → traversal manual buscando nodos `call` / `call_expression`

---

#### `_extract_call_names_from_tree(tree, source_bytes, language_name) -> list[str]`

Recorre el AST con traversal DFS. Para cada nodo `call` o `call_expression`, extrae el campo `function` y lo pasa a `_extract_name()`.

---

#### `_extract_name(node, source_bytes, calls) -> None`

Dispatch dict sobre `node.type`:

```python
_NODE_EXTRACTORS: dict[str, _NodeExtractor] = {
    "identifier":          _extract_identifier,    # foo()          Python/TS/Go/Java/...
    "field_identifier":    _extract_identifier,    # field call     Go
    "attribute":           _extract_attribute,     # obj.method()   Python
    "member_expression":   _extract_attribute,     # obj.method()   TS/JS
    "selector_expression": _extract_selector,      # pkg.Func()     Go
    "scoped_identifier":   _extract_scoped,        # mod::func()    Rust
}
```

**Extensión:** agregar soporte para un nuevo tipo de nodo = 1 línea en el dict.

---

### `engine.py`

#### `trace_dependencies(extracted_context, ast_context, repo_root, parser_manager, visited_nodes=None, max_depth=15) -> TracerResult`

**Función pública principal del módulo tracer.**

```python
from core_ast.tracer.engine import trace_dependencies

result = trace_dependencies(
    extracted_context=handler_extracted,
    ast_context=controller_ctx,
    repo_root=Path("."),
    parser_manager=manager,
)
# result.mode               → "surgical" | "hybrid" | "fallback"
# result.completion_ratio   → 0.0 – 1.0
# result.dependency_chain   → [ExtractedContext, ...]
# result.unresolved_calls   → ["missing_func", ...]
# result.selected_files     → [Path, ...]  (modos B y C)
```

**Flujo en 4 fases:**
1. `_recursive_trace()` → produce `DependencyContext` (dependency_chain + unresolved_calls)
2. Calcula `expected = resolved + unresolved`
3. `decide_mode(expected, resolved, unresolved)` → modo + ratio + razón
4. Construye `TracerResult` según el modo (llama a `build_fallback_bundle` en modos B/C)

---

#### `_recursive_trace(..., visited_nodes, max_depth, current_depth) -> DependencyContext`

Motor interno recursivo.

**Guardas de terminación:**
1. `current_depth >= max_depth` → retorna vacío (salvaguarda profundidad)
2. `sig in visited_nodes` → retorna vacío (prevención de ciclos)

**Pasos:**
1. `detect_calls()` → llamadas en el snippet
2. `analyze_imports()` → imports del archivo completo
3. `_filter_traceable_calls()` → filtra builtins del lenguaje
4. `get_resolver(language)` → instancia el resolver
5. Para cada llamada: `_resolve_and_extract()` con recursión

---

#### `_filter_traceable_calls(call_names, ast_context, imports) -> list[str]`

Filtra builtins respetando overrides:

| Regla | Condición | Acción |
|-------|-----------|--------|
| 1 | `call` no está en `blocked` (builtins del lenguaje) | Rastrear |
| 2 | `call` está en imports explícitos del archivo | Rastrear (override) |
| 3 | `call` tiene definición local en el archivo | Rastrear (override) |
| 4 | Ninguna de las anteriores | Omitir |

---

#### `_find_file_in_directory(directory, function_name, language_name) -> Path | None`

Busca en un directorio (Go package, Python package) el archivo concreto que contiene `function_name`.

- Itera archivos con la extensión del lenguaje
- Verifica que `function_name` aparece en el texto del archivo
- Retorna el primero que coincide, o `None`

---

### Modelo de datos (tracer)

```python
class TracerResult(BaseModel):
    mode: Literal["surgical", "hybrid", "fallback"]
    completion_ratio: float       # ge=0.0, le=1.0
    expected_calls: int           # ge=0
    resolved_calls: int           # ge=0
    unresolved_calls: list[str]   # default=[]
    forced_abort_reason: str | None
    dependency_chain: list[ExtractedContext]  # default=[]
    selected_files: list[Path]               # default=[]
    truncation_applied: bool                 # default=False
```

**Invariante:** `expected_calls == resolved_calls + len(unresolved_calls)`

---

### Tests — tracer

```
tests/test_tracer/
├── test_call_detector.py     → Python calls (6), TS calls (4), Go selector (3),
│                               deduplication (2), empty (2) — baseline
└── test_tracer_extended.py   → detect_calls extendido (9),
                                _is_local_definition (3),
                                _filter_traceable_calls (6),
                                _find_file_in_directory (6),
                                trace_dependencies E2E (12),
                                TracerResult model (6)
```

Cobertura objetivo: `call_detector.py` ≥ 85% · `engine.py` ≥ 80%

---

## Módulo 7 — `quality`

**Propósito:** Decidir si el rastreo quirúrgico fue suficiente (política de modo A/B/C) y construir el bundle de contexto alternativo cuando no lo fue.

### Archivos

| Archivo | Responsabilidad |
|---|---|
| `quality/policy.py` | Funciones puras de decisión de modo |
| `quality/fallback_planner.py` | Construcción del bundle acotado de archivos |

---

### `policy.py`

#### `compute_completion_ratio(expected_calls: int, resolved_calls: int) -> float`

```python
if expected_calls == 0: return 1.0
return min(resolved_calls / expected_calls, 1.0)
```

---

#### `detect_forced_abort(unresolved_calls: list[str]) -> str | None`

Revisa si alguna llamada no resuelta contiene un keyword crítico de `TRACER_CRITICAL_KEYWORDS` (ej. `"auth"`, `"payment"`, `"verify"`, `"fraud"`).

- Retorna el mensaje de razón si hay match
- Retorna `None` si no hay función crítica sin resolver

---

#### `decide_mode(expected_calls, resolved_calls, unresolved_calls) -> tuple[str, float, str | None]`

**Función principal de política.**

```python
mode, ratio, reason = decide_mode(10, 7, ["missing_func"])
# mode = "surgical"  (ratio=0.7 ≥ 0.67, sin función crítica)
```

**Lógica:**
1. `ratio = compute_completion_ratio(expected, resolved)`
2. `forced = detect_forced_abort(unresolved)` — si hay función crítica → `("fallback", ratio, forced)`
3. `ratio >= 0.67` → `("surgical", ratio, None)`
4. `ratio >= 0.33` → `("hybrid", ratio, None)`
5. else → `("fallback", ratio, None)`

Umbrales configurables en `cte/constants.py`: `TRACER_THRESHOLD_SURGICAL=0.67`, `TRACER_THRESHOLD_HYBRID=0.33`.

---

### `fallback_planner.py`

#### `build_fallback_bundle(controller_path, imports, unresolved_calls, repo_root, max_files, max_total_lines, max_lines_per_file) -> tuple[list[Path], bool]`

**Función pública.** Construye la lista priorizada de archivos para el bundle de fallback.

```python
from core_ast.quality.fallback_planner import build_fallback_bundle

files, truncated = build_fallback_bundle(
    controller_path=Path("app/ctrl.py"),
    imports=imports,
    unresolved_calls=["verify_token"],
    repo_root=Path("."),
)
# files     → [Path("app/ctrl.py"), Path("app/auth.py"), ...]
# truncated → True si se llegó al límite de presupuesto
```

**Prioridad de selección:**
1. Archivo controlador (siempre primero)
2. `_resolve_import_paths()` — imports directos locales
3. `_find_candidates_for_unresolved()` — archivos que mencionan las llamadas no resueltas

**Presupuesto duro (configurable vía parámetros, defaults en `cte/constants.py`):**
- `TRACER_MAX_FILES = 10`
- `TRACER_MAX_TOTAL_LINES = 2000`
- `TRACER_MAX_LINES_PER_FILE = 500`

---

#### `_is_excluded(filepath: Path, repo_root: Path) -> bool`

Retorna `True` si algún directorio en la ruta relativa del archivo está en `TRACER_EXCLUDE_DIR_PATTERNS` (`tests`, `vendor`, `node_modules`, `migrations`, `dist`, etc.). Comparación case-insensitive.

---

#### `_count_lines(filepath: Path) -> int`

Cuenta líneas del archivo. Retorna `0` en caso de `OSError` (silent fail).

---

#### `_resolve_import_paths(imports, controller_path, repo_root) -> list[Path]`

Heurística liviana para encontrar archivos de imports directos en disco:
- Imports relativos → resuelve desde `controller_path.parent`
- Imports absolutos → prueba como ruta relativa al repo y al directorio del controlador
- Prueba extensiones: `""`, `.py`, `.ts`, `.js`, `.tsx`, `.go`, `.java`
- Prueba `__init__.py` / `index.ts` / `index.js` como fachada de paquete

---

#### `_shallow_scan(repo_root: Path, max_depth: int) -> list[Path]`

Escanea el repositorio hasta `max_depth` niveles. Excluye directorios en `TRACER_EXCLUDE_DIR_PATTERNS`. Más rápido que `os.walk()` sobre repos grandes.

---

### Tests — quality

```
tests/test_quality/
├── test_policy.py           → compute_ratio (5), detect_abort (6),
│                              decide_mode ABC (8) — baseline
├── test_fallback_planner.py → build_bundle prioridad (4), presupuesto (5),
│                              exclusiones (4), unresolved scan (3) — baseline
└── test_quality_extended.py → policy ratios borde (6), keywords críticos (8),
                               decide_mode forzado (4), _is_excluded (6),
                               _count_lines (4), _resolve_import_paths (8),
                               _shallow_scan (4), build_bundle E2E (8)
```

Cobertura objetivo: `policy.py` ≥ 90% · `fallback_planner.py` ≥ 80%

---

## Module 8 — `packager`

**Purpose:** Turn the analysis output (`ExtractedContext` + `TracerResult`) into a
single, XML-tagged, size-measured, UTF-8-sanitized `LLMPayload` ready for the
inference engine. It replaces the old comment-based bundle without duplicating the
packaging logic.

### Files

| File | Responsibility |
|---|---|
| `packager/xml.py` | Pure XML assembly of the `system_context` (`render_system_context`, `SelectedFile`) |
| `packager/tokens.py` | `estimate_tokens` — tiktoken when installed, character heuristic otherwise |
| `packager/sanitization.py` | `sanitize_utf8` — guarantees valid UTF-8 output |
| `packager/facade.py` | `build_llm_payload` — reads fallback files, renders, sanitizes, measures |

---

### `facade.py`

#### `build_llm_payload(extracted: ExtractedContext, tracer_result: TracerResult) -> LLMPayload`

**Public entry point of the packager.**

```python
from core_ast import build_llm_payload

payload = build_llm_payload(extracted, tracer_result)
# payload.system_context     → "<source_context>...</source_context>"
# payload.estimated_tokens   → 1234
# payload.is_partial_context → True if non-surgical mode or unresolved calls
```

**Flow:**
1. Reads each `tracer_result.selected_files` (the only I/O), degrading a read error
   into a `SelectedFile(path, error=...)` instead of failing.
2. Delegates to the pure `render_system_context`.
3. Sanitizes the result to valid UTF-8.
4. Computes `estimated_tokens` and `is_partial_context`.

`is_partial_context` is `True` when `unresolved_calls` is non-empty **or** `mode != "surgical"`.

---

### `xml.py`

#### `render_system_context(*, primary, dependencies, files, unresolved_calls) -> str`

Pure, deterministic, no I/O. Wraps everything in a `<source_context>` root:

```xml
<source_context>
<primary_controller filepath="app/api.py" name="play_song">
<![CDATA[ ...controller code... ]]>
</primary_controller>
<dependencies>
<dependency filepath="app/validate.py" name="validate"><![CDATA[ ... ]]></dependency>
</dependencies>
<selected_files>
<file path="models/user.py"><![CDATA[ ...file content... ]]></file>
<file path="broken.py" error="..."/>
</selected_files>
<missing_context>
<unresolved_call>charge_card</unresolved_call>
</missing_context>
</source_context>
```

- Optional blocks (`<dependencies>`, `<selected_files>`, `<missing_context>`) are
  **omitted when empty**.
- Source code is wrapped in `CDATA` so the model reads it verbatim; a literal `]]>`
  terminator is split into `]]]]><![CDATA[>`.
- Attribute values are escaped with `xml.sax.saxutils.quoteattr`; `<unresolved_call>`
  text with `escape`. A `None` filepath renders as `filepath=""`.

`SelectedFile` is the renderer's input contract for fallback files (already read by
the facade): `path` plus either `content` (success) or `error` (read failure).

---

### `tokens.py`

#### `estimate_tokens(text: str) -> int`

Prefers a cached `tiktoken` (`cl100k_base`) encoder; falls back to
`len(text) // 4` when tiktoken is not installed. The optional dependency lives in
the `tokens` extra (`pip install -e ".[tokens]"`); the packager never hard-depends
on it.

---

### `sanitization.py`

#### `sanitize_utf8(text: str) -> str`

Re-encodes with `errors="replace"` so the final `system_context` is always valid
UTF-8 (lone surrogates and malformed code points become the replacement character).

---

### Data model (packager)

```python
class LLMPayload(BaseModel):
    system_context: str        # XML block with controller + dependencies
    estimated_tokens: int      # ge=0
    is_partial_context: bool   # non-surgical mode or unresolved calls
```

Defined in `models/llm_payload.py`, re-exported from `core_ast`.

---

### Tests — packager

```
tests/test_packager/
├── test_llm_payload.py   → DTO validation (3)
├── test_sanitization.py  → valid passthrough, surrogates, empty (4)
├── test_tokens.py        → encoder path, heuristic fallback, tiktoken present/absent (6)
├── test_xml.py           → primary, dependencies, files, missing_context, escaping, CDATA (12)
├── test_facade.py        → 3 tracer modes, partial context, file read error, token size (7)
└── test_api_wiring.py    → public API surface, end-to-end payload, bundle delegation (4)
```

Coverage: `packager/` 100%

---

## Ejecutar tests por módulo

```bash
# Todos los módulos
cd core_ast && python -m pytest tests/ --cov=src -q

# Solo locator
python -m pytest tests/test_locator/ --cov=src/locator --cov-report=term-missing

# Solo ast_builder
python -m pytest tests/test_ast_builder/ --cov=src/ast_builder --cov-report=term-missing

# Solo extractor
python -m pytest tests/test_extractor/ --cov=src/extractor --cov-report=term-missing

# Solo import_analyzer (US-4)
python -m pytest tests/test_import_analyzer/ --cov=src/import_analyzer --cov-report=term-missing

# Solo resolver (US-4)
python -m pytest tests/test_resolver/ --cov=src/resolver --cov-report=term-missing

# Solo tracer (US-4)
python -m pytest tests/test_tracer/ --cov=src/tracer --cov-report=term-missing

# Solo quality (US-4)
python -m pytest tests/test_quality/ --cov=src/quality --cov-report=term-missing

# Todos los módulos de US-4 juntos con cobertura combinada
python -m pytest tests/test_import_analyzer/ tests/test_resolver/ tests/test_tracer/ tests/test_quality/ \
    --cov=src/import_analyzer --cov=src/resolver --cov=src/tracer --cov=src/quality \
    --cov-report=term-missing
```
