# custom-schemathesis

Motor de validación determinístico del pipeline. Su responsabilidad es convertir contratos de endpoint enriquecidos por el LLM en estrategias concretas de Hypothesis y ejecutarlas contra la API objetivo de forma asíncrona, controlada y reproducible.

A diferencia de Schemathesis —que parsea un contrato OpenAPI genérico y genera datos con Hypothesis sin más contexto—, este módulo introduce tres diferenciales:

1. **Reglas por tipo con control fino**: cada parámetro tiene un contrato explícito con `type` y restricciones controladas. La LLM solo puede rellenar campos permitidos por tipo (`ALLOWED_FIELDS_BY_TYPE`).
2. **Presupuesto adaptativo y reducción de combinatoria**: el espacio de generación se estima antes de compilar, se reparte por fases (`valid`, `boundary`, `invalid`, `attack`) y se limita con un techo duro para evitar explosión combinatoria.
3. **Priorización por riesgo de endpoint**: los endpoints críticos pueden asignarse un perfil de riesgo que orientará el esfuerzo de fuzzing.

## Pipeline

```
StrategyMode
    ↓
questionnaire.builder  →  QuestionnaireBundle  (plantilla vacía para LLM)
    ↓ (LLM rellena)
questionnaire.resolver  →  CompilerInput       (contratos ya validados)
    ↓
strategy_compiler.compile()  →  EngineInput    (estrategias Hypothesis por zona)
    ↓
engine  →  HTTP API  →  ExecutionResult
```

## Arquitectura de capas

### `src/models/`

Capa de contratos tipados. Todo el dominio del módulo vive aquí. Ninguna otra capa define modelos propios de dominio.

Subdivisión:

```
models/
  strategy_mode.py          → StrategyMode enum (DEFAULT | HACKER)
  questionnaire/
    questionnaire.py        → QuestionnaireBundle, QuestionnaireEndpointItem, QuestionnaireEndpointContracts
    resolved.py              → ResolvedQuestionnaireBundle, ResolvedQuestionnaire (re-exporta CombinationLimits)
    rules.py                 → QUESTIONNAIRE_RULES_BY_MODE, DEFAULT_QUESTIONNAIRE_RULES, HACKER_QUESTIONNAIRE_RULES
  compiler/
    endpoint_info.py         → EndpointInfo (identidad + contratos por zona HTTP del endpoint)
    compiler_input.py        → CompilerInput (lista de EndpointInfo, entrada al compilador)
    budget.py                → CombinationLimits (límites de combinatoria)
    contracts/
      strategies/
        base.py               → BaseStrategyContract (contrato técnico estándar)
        hacker.py              → HackerStrategyContract (extiende base con knobs ofensivos)
      endpoint_controls.py    → EndpointRiskContract, EndpointBudgetContract
      response.py              → ResponseContract (forma esperada de la respuesta por status)
      normalization.py         → ALLOWED_FIELDS_BY_TYPE, ALLOWED_FIELDS_BY_TYPE_HACKER
      state_link.py             → StateLinkContract, StateProduction, StateConsumption, TransitionInvariant
  engine/
    engine_input.py           → EngineInput, CompiledExecutionEndpoint, CompiledEndpointStrategies, CompiledRequestPart
    execution.py               → ExecutionConfig, RequestBlueprint, ExecutionResult, ErrorCategory
    crash_report.py            → CrashReport, InvariantViolation
    results.py                  → EngineRunResult, RunStats, EndpointStats, RawFinding
```

#### Contratos (`models/compiler/contracts/`)

`BaseStrategyContract` es el contrato raíz. Modela los constraints técnicos estándar de JSON Schema: `type`, rangos, longitudes, listas, objetos, `enum`, `pattern`, `nullable`, etc. Usa `extra="forbid"` para rechazar campos que el LLM no debería enviar.

`HackerStrategyContract` extiende el base con knobs ofensivos de alto nivel: `attack_profiles`, `focus_fields`, `sensitive_fields`, `aggressiveness`, `mutation_depth`, `invalid_input_ratio`, `include_encoded_variants`, `include_null`, `include_unicode`, `include_control_chars`, etc. No contiene payloads concretos; eso lo decide el compilador.

`EndpointRiskContract` modela sensibilidad y criticidad del endpoint. `EndpointBudgetContract` modela presupuesto de generación y reparto de fases. Están separados porque priorización y consumo de ejemplos son decisiones independientes.

`ALLOWED_FIELDS_BY_TYPE` y `ALLOWED_FIELDS_BY_TYPE_HACKER` son tablas inmutables que definen qué campos del contrato son legales por tipo JSON Schema. La validación de la LLM depende de estas tablas, no de lógica condicional dispersa.

`StateLinkContract` es el contrato **opcional** que habilita el fuzzing stateful (ver [Fuzzing stateful](#srcenginestrategiesstateful_fuzzer-fuzzing-stateful)). Declara, de forma puramente declarativa: qué campo de una respuesta guardar en qué bundle (`StateProduction`), qué bundle reinyectar en qué zona del request (`StateConsumption`) y qué invariante de transición verificar tras producir un recurso (`TransitionInvariant`). Por defecto es `None`: un endpoint sin enlaces de estado se fuzzea exactamente como antes.

#### `EndpointInfo` y `CompilerInput`

`EndpointInfo` es la unidad central de información por endpoint. Contiene: `method`, `path_url`, `base_url`, y cuatro zonas HTTP —`path_params`, `query_params`, `header_params`, `body`— cada una como mapa `str → BaseStrategyContract | HackerStrategyContract`. También incluye `risk` y `budget` opcionales.

`CompilerInput` es la salida del questionnaire y la entrada del compilador: `strategy_mode` global + lista de `EndpointInfo`. El modo vive a nivel global porque afecta las reglas del cuestionario, los tipos de contrato admitidos, la compilación y la activación de fases de ataque.

#### `CompiledRequestPart` y `CompiledEndpointStrategies`

`CompiledRequestPart` es el resultado de compilar una zona HTTP: contiene `location` (path/query/header/body), `schema` (JSON Schema normalizado) y `strategy` (objeto `SearchStrategy` de Hypothesis listo para generar datos).

`CompiledEndpointStrategies` agrupa las cuatro zonas compiladas de un endpoint.

#### `EngineInput` y `CompiledExecutionEndpoint`

`CompiledExecutionEndpoint` combina la metadata de ejecución del endpoint (method, path_url, base_url, risk, budget) con su `CompiledEndpointStrategies`. Es la unidad de trabajo del engine. Incluye además un `state_link` opcional (`StateLinkContract | None`) que el fuzzer stateful consume y el stateless ignora.

`EngineInput` es la lista de `CompiledExecutionEndpoint` más la configuración global. Es la única entrada que el engine necesita.

---

### `src/questionnaire/`

Capa de frontera con el exterior. Su única responsabilidad es emitir una plantilla de cuestionario para que el LLM la rellene, y luego validar y transformar la respuesta en un `CompilerInput` seguro.

No compila ni ejecuta nada. El compilador recibe datos ya validados.

#### `builder.py`

Construye el `QuestionnaireBundle` vacío. Selecciona las reglas correctas vía `QUESTIONNAIRE_RULES_BY_MODE` según el `StrategyMode`. Sin lógica condicional propia: la selección de reglas es un lookup.

#### `resolver.py`

Convierte el bundle rellenado en `CompilerInput`. Responsabilidades:
- Validar el `ResolvedQuestionnaireBundle` contra el modo global.
- Coaccionar modelos opcionales (`risk`, `budget`) a sus tipos Pydantic.
- Validar que cada contrato tenga `type` y solo use campos permitidos.
- Construir `EndpointInfo` por endpoint.
- Devolver `ResolvedQuestionnaire` con el `CompilerInput` final.

#### `policy.py`

Contiene las reglas de validación y las heurísticas de presupuesto. Funciones principales:

- `validate_endpoint_contract_types(endpoint)` — verifica que cada contrato de las cuatro zonas tenga campo `type`.
- `validate_contract_allowed_fields(contract, mode)` — verifica que el contrato no use campos que la tabla de ese tipo no permite.
- `validate_endpoint_contract_allowed_fields(endpoint, mode)` — aplica la anterior a todas las zonas.
- `estimate_parameter_space(params)` — heurística que estima el espacio combinatorio total de un mapa de parámetros (producto de opciones por campo).
- `compute_combination_limits(endpoint) → CombinationLimits` — estima el espacio, lo capa con un máximo duro y reparte ejemplos entre fases `valid`, `boundary`, `invalid`, `attack`.

La validación y la heurística están separadas intencionalmente: la primera es una verificación de corrección, la segunda es una política ajustable.

---

### `src/strategy_compiler/`

Capa de traducción. Recibe `CompilerInput` (ya validado por el questionnaire) y produce `EngineInput` (estrategias Hypothesis listas para ejecución, organizadas por zona y por fase).

**El compilador no toma decisiones de dominio.** No re-valida contratos ni reinterpreta el modo global. Solo traduce.

#### Arquitectura interna

```
strategy_compiler/
  compiler.py               → orquestador: compile(CompilerInput) → EngineInput
  schema_compiler/
    __init__.py              → ContractCompiler Protocol, _REGISTRY, compile_contract, register_compiler
    default/
      compiler.py             → DefaultContractCompiler (valid / boundary / invalid; attack → fallback a valid)
      phases.py                → build_valid_strategy, build_boundary_strategy, build_invalid_strategy
      type_strategies.py       → valid_for_type, string_strategy, array_strategy, object_strategy, compile_for_phase
      constraints.py           → INT_BOUNDARY, FLOAT_BOUNDARY + helpers numéricos compartidos
    hacker/
      compiler.py              → HackerContractCompiler (delega a default para non-attack)
      builders.py               → build_attack_payloads, _encode_variants, mutate_object
      tables.py                  → tablas de strings por perfil de ataque (solo datos)
```

**Extensión para un nuevo tipo de contrato:**
1. Implementar `ContractCompiler` Protocol.
2. Registrar: `register_compiler(MiContractType, MiCompiler())`.

No se modifica ningún archivo del núcleo.

#### `compiler.py`

Punto de entrada canónico: `compile(CompilerInput) → EngineInput`.

Para cada `EndpointInfo`:
1. Determina las fases activas según `strategy_mode`: DEFAULT (`valid`, `boundary`, `invalid`), HACKER (+ `attack`).
2. Compila cada zona HTTP (`path`, `query`, `headers`, `body`) de forma independiente vía `_compile_zone`.
3. Por zona: construye un `st.fixed_dictionaries({param: compile_contract(contract, phase)})` para cada fase.
4. Empaqueta todo en `CompiledRequestPart` (con `strategies_by_phase` poblado) → `CompiledEndpointStrategies` → `CompiledExecutionEndpoint`.
5. Propaga el plan de generación (`CombinationLimits` serializado) en `generation_plan` de `CompiledEndpointStrategies`.

Los parámetros de `path` se fuerzan siempre a `required=True`, independientemente del contrato.

Salida: `EngineInput`.

#### `schema_compiler/`

Submodulo de despacho. Traduce un `BaseStrategyContract` (o subclase) a una `SearchStrategy` de Hypothesis mediante el `_REGISTRY`.

**Protocol `ContractCompiler`** (en `schema_compiler/__init__.py`):

```python
class ContractCompiler(Protocol):
    def compile_contract(self, contract: BaseStrategyContract, phase: str) -> SearchStrategy: ...
```

**`_REGISTRY: dict[type[BaseStrategyContract], ContractCompiler]`** — precargado con:
- `BaseStrategyContract → DefaultContractCompiler`
- `HackerStrategyContract → HackerContractCompiler`

**`compile_contract(contract, phase)`** — despacha al compilador registrado para `type(contract)`. Lanza `StrategyCompilationError` (de `src/exceptions.py`) si no hay compilador.

**`register_compiler(type, compiler)`** — API pública para extensión sin modificar el núcleo.

#### `schema_compiler/default/`

Maneja `BaseStrategyContract`. Sin conocimiento de `HackerStrategyContract` ni de `hacker/`.

**`compiler.py` — `DefaultContractCompiler`**

Despacha por fase a las funciones de `phases.py`. La fase `attack` hace fallback silencioso a `build_valid_strategy`: `BaseStrategyContract` no tiene knobs ofensivos.

**`phases.py` — builders por fase**

- `build_valid_strategy` — genera valores correctos: `const` → `st.just`, `enum` → `st.sampled_from`, tipo conocido → `valid_for_type`, sin tipo → `fallback_from_jsonschema`. Wrappea con `st.one_of(st.none(), base)` si `nullable=True`.
- `build_boundary_strategy` — bordes del dominio: para `integer`, calcula candidatos con `integer_boundary_values(min, max)` y filtra con `boundary_int_filter`; para `string`, genera strings en `minLength`, `maxLength` y sus adyacentes; para `array`/`object`, delega con `phase="boundary"`.
- `build_invalid_strategy` — tipos incorrectos y valores fuera de rango: `st.text`/`st.none()` para numéricos, `st.integers()`/`st.booleans()` para strings, valores de `integer_attack_values()` que caigan fuera del rango declarado.

**`type_strategies.py` — builders por tipo**

- `valid_for_type(t, data, contract)` — despacho por tipo JSON Schema a builders específicos.
- `string_strategy` — elige entre regex de formato conocido (`FORMAT_PATTERNS`: `email`, `uuid`, `date`, `date-time`, `uri`, `ipv4`, `hostname`, `byte`), regex custom (`pattern`), o `st.text`.
- `array_strategy` — `st.lists(compile_for_phase(items, phase), min_size, max_size)`.
- `object_strategy` — `st.fixed_dictionaries(required={...}, optional={...})` construido recursivamente desde `contract.properties`.
- `compile_for_phase(contract, phase)` — dispatcher recursivo para contratos anidados. Usa import diferido de `phases.py` para romper la dependencia circular `phases → type_strategies → phases`.
- `strategy_from_jsonschema` — atributo parcheable que apunta a `hypothesis_jsonschema.from_schema` si está instalado, o `None`. Usado por `fallback_from_jsonschema` para constructos no cubiertos nativamente (`anyOf`, `oneOf`, `$ref`, `format` desconocido).

**`constraints.py` — datos numéricos compartidos**

Tablas y helpers puros (sin imports de Hypothesis). Compartidos por `default/` y `hacker/`.

- `INT_BOUNDARY`, `FLOAT_BOUNDARY` — valores extremos y de borde de tipos numéricos.
- `integer_boundary_values(min, max)`, `number_boundary_values(min, max)` — enriquecen las tablas base con aristas del rango declarado.
- `integer_attack_values()`, `number_attack_values()` — sublistas para la fase attack.
- `resolve_min_int`, `resolve_max_int`, `resolve_min_float`, `resolve_max_float` — normalizan `minimum`/`exclusiveMinimum` a un valor concreto.
- `multiple_of_filter`, `boundary_int_filter`, `is_out_of_range` — predicados usados como `.filter()` o para selección manual de candidatos.

#### `schema_compiler/hacker/`

Extiende DEFAULT agregando la fase `attack` para `HackerStrategyContract`. Depende de `default/`; `default/` nunca importa de `hacker/`.

**`compiler.py` — `HackerContractCompiler`**

Compone sobre `DefaultContractCompiler`: delega todas las fases excepto `attack`. Para `attack`, llama a `_build_attack(contract)` que extrae knobs del contrato y llama a `build_attack_payloads`.

**`builders.py` — lógica de construcción de payloads**

- `build_attack_payloads(value_type, profiles, *, include_encoded_variants, include_nulls, include_large_values, minimum, maximum)` — despacha por tipo:
  - `string`: toma `PROFILE_STRING_PAYLOADS[profile]` por cada perfil (o `GENERIC_STRING_PAYLOADS` si no hay), opcionalmente expande con `_encode_variants` (original + URL-encoded + Base64). Agrega nullbytes si `include_nulls`.
  - `integer`/`number`: `integer_attack_values()` + `integer_boundary_values(min, max)` (importados de `default/constraints.py`). `None` si `include_nulls`.
  - `boolean`: lista fija que mezcla tipos intencionalmente (`True`, `False`, `None`, `0`, `1`, `"true"`, `"false"`, `"null"`).
  - `array`/`object`: listas/dicts con mutaciones de prototype pollution, overflow y nulls.
  - Devuelve `st.sampled_from(unique)` tras deduplicar; `st.none()` si la lista queda vacía.
- `_encode_variants(payload)` — expande un string a [original, URL-encoded, Base64].
- `mutate_object(obj, depth)` — aplica prototype pollution, overflow y campos extra; recursivo hasta `depth`.

**`tables.py` — datos puros**

Doce tablas de strings por vector de ataque: `_SQL`, `_XSS`, `_PATH_TRAVERSAL`, `_SSRF`, `_AUTH_BYPASS`, `_INPUT_VALIDATION`, `_DESERIALIZATION`, `_PARSER_COMPAT`, `_HEADERS_COOKIE`, `_INFO_DISCLOSURE`, `_RESOURCE_ABUSE`, `_BUSINESS_LOGIC`.

- `PROFILE_STRING_PAYLOADS` — mapea nombre de perfil → lista de strings.
- `GENERIC_STRING_PAYLOADS` — subconjunto fijo para cuando no hay perfiles declarados.

Sin imports de Hypothesis ni stdlib pesado.

---

### `src/engine/`

Capa de ejecución. Recibe `EngineInput` (estrategias ya compiladas) y ejecuta requests HTTP asíncronos contra la API objetivo, valida invariantes de respuesta, reduce (shrink) cada hallazgo a su reproductor mínimo y deduplica los reportes.

**El engine no conoce contratos ni modos de estrategia.** Solo consume `EngineInput`.

#### Arquitectura interna

```
__init__.py                       → run(engine_input, config, *, stateful=False) → EngineRunResult
protocols.py                       → FuzzStrategy, StatefulFuzzStrategy (Protocols estructurales)
core/
  orchestrator.py                  → AsyncOrchestrator (cliente persistente, semáforo, reintentos)
  context_injector.py              → ContextInjector (interpola params, construye URL, ensambla request)
  error_classifier.py              → ErrorClassifier (mapea respuestas/excepciones a ErrorCategory)
  response_validator.py            → ResponseValidator (valida invariantes de respuesta → InvariantViolation)
  report_deduplicator.py            → dedupe_crash_reports (colapsa reportes del mismo defecto)
  hypothesis_bridge.py              → run_sync (corre corrutinas async desde callbacks síncronos de Hypothesis)
strategies/
  async_http_fuzzer/                → AsyncHttpFuzzer (stateless, por defecto)
  stateful_fuzzer/                  → StatefulFuzzer (stateful; ver sección siguiente)
```

Los modelos del engine viven en `models/engine/` (`ExecutionConfig`, `RequestBlueprint`, `ExecutionResult`, `ErrorCategory`, `CompiledExecutionEndpoint`, `EngineInput`, `CrashReport`, `InvariantViolation`, `EngineRunResult`, `RunStats`).

#### `__init__.py` — orquestación

`run(engine_input, config, *, stateful=False)` abre un único orquestador para toda la corrida y, según el flag, ejecuta el camino stateless o el stateful; luego deduplica los reportes confirmados y arma las estadísticas (`EngineRunResult`). En modo stateless explora cada endpoint, recolecta `RawFinding` y shrinkea cada uno; en modo stateful delega en `StatefulFuzzer.fuzz_sequence`. El ciclo de vida del cliente HTTP y el conteo de estadísticas por request son helpers compartidos por ambos caminos.

#### `protocols.py`

Dos `Protocol` estructurales (extensión por estructura, no por herencia):
- `FuzzStrategy` — testeo stateless por endpoint. Expone `name`, `fuzz(endpoint, config) → (list[ExecutionResult], list[RawFinding])` y `shrink(finding, config) → CrashReport | None`.
- `StatefulFuzzStrategy` — testeo stateful sobre el conjunto. Expone `name` y `fuzz_sequence(endpoints, config) → (list[ExecutionResult], list[CrashReport])`.

#### `core/orchestrator.py`

`AsyncOrchestrator` es el único punto de contacto del engine con la red:
- Un único `httpx.AsyncClient` compartido por toda la corrida (reusa conexiones TCP, evita agotar sockets).
- Limita concurrencia con un `asyncio.Semaphore`.
- Reintenta solo fallos transitorios de infraestructura (`429`/`502`/`503` y `ConnectTimeout`) con exponential backoff + jitter (`espera = 2^n · base + jitter`, con techo `MAX_BACKOFF_S`).
- Los errores de transporte **nunca escapan**: cada intento se convierte en un `ExecutionResult` (con `status_code=None` y una `ErrorCategory` de transporte), de modo que un endpoint caído no aborta la corrida. Clasifica resultados pero nunca interpreta invariantes — eso es del `ResponseValidator`.

#### `core/context_injector.py`

`ContextInjector.build` convierte un payload por zona (`path`/`query`/`header`/`body`) en un `RequestBlueprint` inmutable: interpola path params (un faltante es `EngineError`), construye la URL absoluta desde `base_url` + `path_url`, mezcla headers y elige el content-type. Transformación pura: sin HTTP ni Hypothesis.

#### `core/error_classifier.py`

Mapea respuestas y excepciones de transporte a `ErrorCategory`:

| Caso | Resultado |
|---|---|
| `classify_response` 5xx | `server_error` |
| `classify_response` 4xx | `client_error` |
| `classify_response` 2xx/3xx | `None` |
| `classify_exception` connect / protocol / connect-timeout | `availability` |
| `classify_exception` otros timeouts | `timeout` |

`contract_violation` no la produce el clasificador: la asigna el fuzzer cuando el `ResponseValidator` detecta una violación de invariante sobre una respuesta 2xx/3xx.

#### `core/response_validator.py`

`ResponseValidator` chequea las invariantes de respuesta declaradas en el endpoint y devuelve la `InvariantViolation` correspondiente (o `None`):
- `NOT_A_SERVER_ERROR` — cualquier 5xx es defecto.
- `STATUS_CODE_CONFORMANCE` — status no declarado en el contrato de respuestas.
- `CONTENT_TYPE_CONFORMANCE` — content-type no coincide.
- `RESPONSE_SCHEMA_CONFORMANCE` — el body no valida contra el schema declarado.
- `STATE_TRANSITION` — usada por el fuzzer stateful para transiciones de estado rotas.

Los fallos de infraestructura (timeouts, conexión) nunca cuentan como violación. También expone `sanitize_headers`, que redacta secretos (`Authorization`, `Cookie`, `X-Api-Key`) antes de persistir.

#### `core/report_deduplicator.py`

`dedupe_crash_reports` colapsa reportes que reproducen el mismo defecto: dos reportes son el mismo bug si comparten endpoint, método, fase, invariante violada, status y payload mínimo (canonicalizado con claves ordenadas). Preserva el orden de aparición. Las estadísticas siguen contando cada hallazgo confirmado; la lista pública expone un reporte por reproductor distinto.

#### `core/hypothesis_bridge.py`

`run_sync(coro)` corre una corrutina async desde código síncrono controlado por Hypothesis. Mantiene un único event loop en un thread daemon para todo el proceso y bloquea esperando el resultado, evitando crear y destruir un loop por ejemplo generado. Lo usan tanto el fuzzer stateless como el stateful.

`settings(deadline=None)` es obligatorio en los tests del engine para evitar falsos positivos por latencia en APIs bajo estrés.

#### `strategies/async_http_fuzzer/` — estrategia stateless (por defecto)

`AsyncHttpFuzzer` implementa `FuzzStrategy` en dos fases:

1. **`fuzz` (exploración)** — Hypothesis genera ejemplos por fase (`valid`/`boundary`/`invalid`/`attack`) desde las `CompiledRequestPart`; cada ejemplo se materializa con `ContextInjector`, se ejecuta vía `AsyncOrchestrator` y se valida con `ResponseValidator`. **No lanza** ante una violación: acumula un `RawFinding` y deja que Hypothesis siga generando. Si se acumulan `MAX_INFRA_FAILURES` fallos de transporte consecutivos, aborta ese endpoint y continúa con el siguiente.
2. **`shrink` (reducción)** — re-ejecuta el hallazgo bajo `hypothesis.find` para minimizar el payload que aún reproduce la violación, y arma un `CrashReport` con el reproductor mínimo (headers sanitizados, status, body). Devuelve `None` si el fallo ya no reproduce (flaky).

`phases.py` descubre las fases y mergea las estrategias por zona (`merged_strategy_for_phase`); `budget.py` resuelve cuántos ejemplos corre cada fase (`examples_for_phase`), tomando el `generation_plan` del compilador como autoritativo.

---

### `src/engine/strategies/stateful_fuzzer/` — Fuzzing stateful

`StatefulFuzzer` es una **segunda estrategia de ejecución** que se suma al `AsyncHttpFuzzer` (stateless) **sin modificarlo**. Mientras el fuzzer por defecto prueba cada endpoint de forma aislada con datos sintéticos, el stateful **encadena requests**: captura valores reales de una respuesta (un `id`, un token) y los reinyecta en requests posteriores, ejercitando flujos de negocio completos (`POST → GET → DELETE → GET`).

Detecta bugs invisibles para el fuzzer stateless: recursos borrados que siguen accesibles, lecturas que no reflejan una actualización previa, tokens que no se invalidan al cerrar sesión, etc.

#### El contrato de enlace de estado

El mapeo "qué guardar y dónde reinyectarlo" es **dato declarativo** (`StateLinkContract`, ver `models/compiler/contracts/state_link.py`), no lógica hardcodeada en el fuzzer. Viaja como campo **opcional** por todo el pipeline (`QuestionnaireEndpointContracts → EndpointInfo → CompiledExecutionEndpoint`). Lo rellena hoy un fixture/spec y, a futuro, la inferencia del LLM (`semantic_inference`): el módulo es agnóstico de quién lo produce.

- `StateConsumption.invalidates` — si es `True`, el valor se **remueve** del bundle al consumirse (vía `hypothesis.stateful.consumes`), de modo que un recurso borrado no pueda volver a operarse. Por defecto el valor queda reutilizable (un mismo `id` sirve para `GET` y `DELETE`).
- `TransitionInvariant.echoed_fields` — además del status, exige que el body del probe de seguimiento **refleje** los campos enviados en el request disparador (ej. tras `PUT {price: 10}`, el `GET` debe devolver `price == 10`). Vacío ⇒ solo se chequea el status.

#### La máquina de estados

`state_machine.build_state_machine(...)` construye dinámicamente un `RuleBasedStateMachine` de Hypothesis:

- un `Bundle` por cada nombre de bundle declarado;
- una `@rule()` por endpoint que: inyecta valores consumidos (`bundles.inject`) → ejecuta vía el orquestador (`run_sync`, el bridge async existente) → captura valores producidos al bundle (`bundles.capture`) → prueba las invariantes de transición;
- `@precondition()` garantiza el orden lógico: no se consume un bundle que ningún endpoint produjo todavía;
- ante la primera invariante rota, la regla **lanza** `StatefulViolationError`, de modo que Hypothesis **reduce (shrink) la secuencia de operaciones** hasta el reproductor mínimo — a diferencia del stateless, que recolecta hallazgos y shrinkea el *payload*.

`transitions.py` materializa el probe de seguimiento reutilizando `ContextInjector`, y valida su respuesta delegando el chequeo de 5xx al `ResponseValidator` existente; agrega la comparación de status esperado y, si hay `echoed_fields`, la comparación de valores contra el body enviado (`InvariantViolation.STATE_TRANSITION`).

**Varios bugs por corrida (loop-until-dry, opcional):** la regla se detiene en el primer fallo, así que por defecto `fuzz_sequence` hace **una sola pasada** (barato: reporta el primer defecto). Subiendo `StatefulConfig.max_distinct_bugs` se activa el bucle: cada pasada reporta un defecto, registra su *firma* `(método, path, invariante)` en un conjunto `suppressed` y vuelve a correr; las reglas registran pero **no relanzan** las firmas ya vistas, así una pasada posterior descubre otros defectos. El bucle termina cuando una pasada no encuentra nada nuevo o al llegar al tope configurado. Cada defecto conserva su shrinking individual.

#### Cómo se invoca

El engine expone el modo con un flag, **sin romper la firma previa**:

```python
run(engine_input, config)                  # stateless (AsyncHttpFuzzer) — comportamiento previo intacto
run(engine_input, config, stateful=True)   # stateful (StatefulFuzzer) — una pasada (default)
run(engine_input, config, stateful=True,   # stateful exhaustivo (loop-until-dry)
    stateful_config=StatefulConfig(max_distinct_bugs=10))
```

`StatefulConfig` ajusta la exhaustividad del modo stateful: `max_distinct_bugs` (default `1`, una pasada), `max_examples` (secuencias por pasada) y `step_count` (largo máximo de cada secuencia). `StatefulFuzzer.fuzz_sequence(endpoints, config, stateful_config)` corre la máquina y devuelve `(results, crash_reports)` ya minimizados (no hay fase de shrink separada). Los reports reutilizan `CrashReport` con un campo opcional `transition_sequence` (los pasos previos al fallo), evitando un segundo tipo de report.

#### Qué cambió respecto del engine previo (stateless)

Todo lo nuevo es **aditivo**; el camino stateless quedó intacto (sus tests no se tocaron):

| Componente previo | Cambio |
|---|---|
| `engine.run(engine_input, config)` | Acepta `*, stateful=False`. Con `True` corre el `StatefulFuzzer`. La firma previa sigue funcionando igual. |
| `protocols.py` (`FuzzStrategy`) | Sin cambios. Se **agrega** `StatefulFuzzStrategy` (opera sobre el conjunto de endpoints, no uno por uno). |
| `AsyncHttpFuzzer` | Sin cambios. Sigue siendo la estrategia por defecto. |
| `CompiledExecutionEndpoint` / `EndpointInfo` / `QuestionnaireEndpointContracts` | Nuevo campo opcional `state_link` (default `None`). |
| `CrashReport` | Nuevo campo opcional `transition_sequence` (default `None`). |
| `InvariantViolation` | Nuevo miembro `STATE_TRANSITION`. |
| `ResponseValidator`, `ContextInjector`, `run_sync`, `AsyncOrchestrator` | Reutilizados **sin modificar**. |

---

### `src/main.py`

Fachada pública mínima. Expone `build_questionnaire`, `resolve_questionnaire`, `compile_strategies` y `run` (con su flag `stateful`), delegando en las capas internas (`questionnaire/`, `strategy_compiler/`, `engine/`). La lógica real vive en esas capas.

---

### `src/constants.py`

Constantes de configuración compartidas por `policy.py`, el cuestionario y el engine: límites por defecto de ejemplos y combinaciones, techo de explosión combinatoria, reparto de fases por defecto (`DEFAULT`: `valid` 60% / `boundary` 25% / `invalid` 15%; `HACKER` agrega `attack` 5% bajando `invalid` a 10%), parámetros de reintentos y backoff del orquestador, presupuesto del fuzzer stateful (`DEFAULT_STATEFUL_MAX_EXAMPLES`, `DEFAULT_STATEFUL_STEP_COUNT`) y heurísticas base para estimar opciones por tipo.

Las constantes viven fuera de los modelos para que las políticas de generación sean ajustables sin tocar contratos ni validadores.

### `src/exceptions.py`

Define las excepciones de dominio del módulo: `PolicyError` (un contrato, regla o campo no cumple las restricciones del cuestionario), `StrategyCompilationError` (un contrato no puede traducirse a una estrategia de Hypothesis), `EngineError` (se viola una invariante de ejecución del engine) y `StatefulLinkError` (un enlace de estado no puede honrarse durante el fuzzing stateful; subclase de `EngineError`). Distinguen fallos de negocio de errores técnicos genéricos.

---

## Decisiones arquitectónicas consolidadas

- `strategy_mode` es global en `CompilerInput`. Nunca repetirlo por endpoint.
- El **cuestionario resuelto** es el único punto donde se valida compatibilidad entre modo y tipo de contrato.
- El **compilador** recibe datos ya validados. No re-normaliza ni re-valida.
- El **engine** no conoce contratos. Solo consume `EngineInput`.
- La fase `attack` solo se activa si el campo tiene `HackerStrategyContract` **y** el modo global es `HACKER`.
- `HACKER` tiene sus propias reglas de validación. No hereda de `DEFAULT`.
- El engine usa `Protocol` para estrategias, no herencia. Hay dos: `FuzzStrategy` (stateless, por endpoint) y `StatefulFuzzStrategy` (stateful, sobre el conjunto). Se eligen con `run(..., stateful=...)`.
- El `hypothesis_bridge` reutiliza un event loop persistente. No crear uno por ejemplo generado. El fuzzer stateful lo reutiliza tal cual desde dentro del `RuleBasedStateMachine` (síncrono).
- `StateLinkContract` es opcional y aditivo: `state_link is None` ⇒ flujo stateless idéntico. El fuzzer stateful no infiere enlaces por heurística; los lee del contrato.
- `extra="forbid"` en todos los modelos Pydantic. Nunca silenciar campos inesperados del LLM.
