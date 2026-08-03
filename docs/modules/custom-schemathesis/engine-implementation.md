# Engine — Implementación

El engine es la última etapa del pipeline `custom_schemathesis`. Recibe un
`EngineInput` (estrategias Hypothesis ya compiladas por el `strategy_compiler`,
por endpoint, zona HTTP y fase) y devuelve un `EngineRunResult` con los crash
reports mínimos reproducibles y las estadísticas del run.

No conoce contratos de entrada, no interpreta el `strategy_mode` y no sabe cómo
se generaron los datos: solo ejecuta requests HTTP, observa respuestas y reporta
violaciones de invariantes.

```text
strategy_compiler.compile(CompilerInput) -> EngineInput
engine.run(EngineInput, ExecutionConfig) -> EngineRunResult
```

## Arquitectura de dos fases

1. **Exploración** — encuentra la mayor cantidad de fallos sin detenerse.
   Hypothesis genera con `phases=[Phase.explicit, Phase.generate]` (sin
   `Phase.shrink`) y el callback **no lanza excepción** ante una violación:
   guarda un `RawFinding` y sigue generando hasta `max_examples`.
2. **Shrinking** — para cada `RawFinding`, `hypothesis.find(strategy, predicate)`
   busca el payload mínimo que aún reproduce el fallo. Es **secuencial** (un
   finding a la vez) para evitar interferencia por estado compartido, rate-limits
   o side effects. Si `find` no lo reproduce, el finding se descarta como flaky.

## Estructura

```text
engine/
  __init__.py                 → run(EngineInput, ExecutionConfig) → EngineRunResult
  protocols.py                → FuzzStrategy (Protocol estructural)
  core/
    orchestrator.py           → AsyncOrchestrator — cliente HTTP, semáforo, retries
    context_injector.py       → ContextInjector — payload por zona → RequestBlueprint
    response_validator.py     → ResponseValidator — invariantes de respuesta
    error_classifier.py       → ErrorClassifier — status/excepción → ErrorCategory
    hypothesis_bridge.py      → event loop persistente + run_sync
    report_deduplicator.py    → dedupe_crash_reports — un reporte por defecto distinto
  strategies/
    async_http_fuzzer/
      fuzzer.py               → AsyncHttpFuzzer (implementa FuzzStrategy)
      phases.py               → descubrimiento de fases + merge de zonas
      budget.py                → ejemplos por fase (plan → budget → defaults)
```

Los modelos de datos viven en `src/models/engine/` junto al resto de modelos del
paquete: `execution.py` (`ErrorCategory`, `INFRA_CATEGORIES`, `ExecutionConfig`,
`RequestBlueprint`, `ExecutionResult`), `results.py` (`RawFinding`,
`EndpointStats`, `RunStats`, `EngineRunResult`), más `engine_input.py` y
`crash_report.py` que produce el compiler. Las constantes compartidas
(`DEFAULT_MAX_EXAMPLES`, `DEFAULT_PHASE_SPLIT`, `MAX_BACKOFF_S`,
`MAX_INFRA_FAILURES`, `DEFAULT_SHRINK_MAX_EXAMPLES`) están en `src/constants.py`
y la excepción de dominio `EngineError` en `src/exceptions.py`.

## Paso a paso

El orden refleja las dependencias: cada paso es un commit atómico que deja la
suite verde y `ruff` limpio, con código y tests juntos.

1. **Modelos (`models/engine/execution.py`, `results.py`).** Tipos puros.
   `ExecutionConfig.base_url` es obligatorio (un `ValidationError` al construir
   la config es más claro que un `availability` sintético después). Un 2xx/3xx
   limpio es `error=None`; `INFRA_CATEGORIES = {availability, timeout}` es la
   única fuente de "esto es transporte, no un hallazgo".

2. **Protocol (`protocols.py`).** `FuzzStrategy` estructural (`@runtime_checkable`):
   cualquier objeto con `name`, `fuzz` y `shrink` es una estrategia válida, sin
   herencia.

3. **Bridge (`core/hypothesis_bridge.py`).** Hypothesis llama al callback de forma
   síncrona, una vez por ejemplo. Un `asyncio.run()` por ejemplo agota
   descriptores; en su lugar hay **un event loop en un daemon thread** y
   `run_sync(coro)` lo usa vía `run_coroutine_threadsafe`.

4. **Clasificador (`core/error_classifier.py`).** `5xx → server_error`,
   `4xx → client_error`, `2xx/3xx → None`. Excepciones de transporte:
   `ConnectError`/`ConnectTimeout`/`UnsupportedProtocol → availability`, otros
   `TimeoutException → timeout`. La categoría `contract_violation` la asigna el
   fuzzer (paso 8), no el clasificador.

5. **Orchestrator (`core/orchestrator.py`).** Un único `httpx.AsyncClient` por run
   (evita agotar sockets en `TIME_WAIT`), `asyncio.Semaphore(max_concurrency)`, y
   `execute(blueprint)` con retries solo en `429/502/503` y `ConnectTimeout`
   (backoff exponencial con jitter). No se reintenta `400/422` (hallazgos), `500`
   (el bug buscado) ni `ReadTimeout`. Las excepciones de transporte no se
   propagan: se convierten en `ExecutionResult` con `status_code=None`.

6. **Inyector (`core/context_injector.py`).** `build(endpoint, payload_by_zone,
   config)` → `RequestBlueprint`: interpola path params (un faltante es
   `EngineError`), arma la URL absoluta, mezcla headers de config con los
   generados (estos ganan) y aplica el content type compilado si hay body. Pura
   transformación de datos.

7. **Validador (`core/response_validator.py`).** Reglas: `not_a_server_error`
   siempre; `status_code_conformance` / `content_type_conformance` /
   `response_schema_conformance` solo si el endpoint declaró `responses`. Un
   resultado de infraestructura (`INFRA_CATEGORIES`) nunca es violación. El body
   se valida con un recorrido recursivo puro contra el `BaseStrategyContract`
   (sin Pydantic). `sanitize_headers` redacta `Authorization`, `Cookie`,
   `X-Api-Key`.

8. **Fuzzer (`strategies/async_http_fuzzer/`).**
   - `phases.py`: descubre las fases (las del `generation_plan` primero, luego las
     presentes en cada zona) y arma la estrategia combinada por fase.
   - `budget.py`: ejemplos por fase resueltos en orden
     `generation_plan["examples_per_phase"]` → `budget.max_examples × phase_split`
     → defaults.
   - `fuzzer.py`: `fuzz` corre `@given` por fase sin lanzar; un resultado de
     infraestructura incrementa un contador y, al llegar a `MAX_INFRA_FAILURES`,
     aborta ese endpoint (el run sigue con el siguiente). Una violación sobre un
     2xx/3xx reclasifica el resultado a `contract_violation` y acumula el finding.
     `shrink` usa `hypothesis.find`; si no reproduce (`NoSuchExample`/
     `Unsatisfiable`) devuelve `None` (flaky), si no materializa el `CrashReport`
     con el payload mínimo y headers sanitizados.

9. **Entry point (`__init__.py`).** `run` abre una sesión, corre la exploración
   endpoint por endpoint, luego el shrinking secuencial de todos los findings, y
   arma `RunStats` (por endpoint, fase y `ErrorCategory`). Antes de devolver,
   `dedupe_crash_reports` colapsa los reportes que comparten método, endpoint,
   fase, invariante, status y payload mínimo: la lista pública expone un reporte
   por defecto distinto (`findings_unique`), mientras `findings_confirmed`
   conserva el total por finding, preservando
   `findings_raw == findings_confirmed + findings_flaky`. La exploración es
   secuencial hoy; la estructura permite paralelizarla sin tocar la firma ni la
   fase 2.

## Decisiones de diseño

- **`phases=[explicit, generate]` + no lanzar**, en vez de capturar la
  `AssertionError` de `@given`: Hypothesis shrinkea internamente antes de
  re-lanzar, así que capturarla pierde el control del proceso. Excluyendo
  `Phase.shrink` el engine decide cuándo y cómo minimizar.
- **`hypothesis.find` para shrinking**: reusa el algoritmo de `conjecture` en vez
  de reimplementarlo.
- **Protocol sobre herencia** para `FuzzStrategy`.
- **Una sesión HTTP por run**, cerrada en `run` (no en `fuzz`): el shrinking reusa
  las conexiones de la exploración.
- **Infraestructura como datos, nunca como hallazgo**: los timeouts/errores de
  conexión se registran en stats pero no generan findings.
- **`MAX_INFRA_FAILURES` es constante, no config**: es estabilidad del engine, no
  política del usuario.
- **Deduplicar los crash reports en el engine**: una corrida produce muchos
  findings que shrinkean al mismo payload mínimo (el mismo bug visto N veces).
  Colapsarlos una sola vez acá —en vez de que cada consumidor lo repita— evita
  ruido en tres frentes:
  - **Auto-fixer (LLM):** recibir N copias del mismo crash desperdicia tokens y
    ensucia el ranking de defectos; lo que quiere son los bugs distintos.
  - **Persistencia:** N filas para un solo defecto infla el storage y hace que
    "cuántos bugs encontró la corrida" dé un número equivocado.
  - **Reporte/CLI (humano):** "24 crashes" se lee como 24 problemas cuando hay 1.
  No se pierde información: `findings_confirmed` conserva el total por finding y
  `findings_unique == len(crash_reports)` es el conteo de defectos distintos.
