# Storage Engine (Persistencia Local)

Este módulo (`lib/storage`) es la capa de persistencia para el sistema `llm-pbt-agent`. Convierte la herramienta en una plataforma auditable, centralizada y trazable.

El motor gestiona de forma automática una base de datos **SQLite** dentro del directorio de la aplicación (`llm-pbt-agent/data/coretest.db`), organizando todo alrededor de la jerarquía **proyecto → análisis → corrida**: un análisis es la receta replicable (contratos ya resueltos, traza de ejecución grabada), y cada corrida es una ejecución de esa receta (la original, que genera y graba, o un replay posterior que la re-envía tal cual).

## Arquitectura (Repository Pattern)

Para garantizar un código limpio, mantenible y escalable, el módulo está diseñado usando el **Patrón Repositorio**:

1. **`StorageEngine` (`db.py`)**: Su única responsabilidad es conectarse a SQLite, configurar la seguridad (ej: Foreign Keys activadas) e inicializar las tablas automáticamente a través del archivo puro `schema.sql`.
2. **Repositories (`repositories/`)**: Data Access Objects (DAOs) separados por entidad. Encapsulan por completo el SQL paramétrico (`INSERT`, `SELECT`), blindando la base contra inyecciones SQL.
3. **Data Transfer Objects (`models.py`)**: Todo lo que entra o sale del motor se valida mediante modelos inmutables de **Pydantic**.
4. **Domain Exceptions (`exceptions.py`)**: Cualquier fallo en la persistencia levanta errores de dominio manejables (ej. `RunNotFoundError`) en lugar de arrojar excepciones internas del driver de SQLite.

---

## Modelos de Datos (DTOs)

A continuación se detalla la estructura de los objetos de persistencia devueltos por el motor.

### `ProjectRecord`
El registro raíz: a qué repositorio pertenecen los análisis.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `name` | `str` | Nombre legible del proyecto. |
| `repo_path` | `str` | Ruta del repositorio en disco. |

### `AnalysisRecord`
La receta replicable: contratos ya resueltos, modo de estrategia y configuración de ejecución.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `project_id` | `int` | **Foreign Key** referenciando a `ProjectRecord.id`. |
| `created_at` | `datetime` | Momento de creación del análisis. |
| `label` | `str \| None` | Etiqueta legible opcional. |
| `generated_against_repo_hash` | `str` | Hash del repo contra el que se generó la traza. |
| `strategy_mode` | `str` | Modo de estrategia de Hypothesis usado para generar. |
| `stateful` | `bool` | Si el análisis corre cadenas stateful. |
| `stateful_config` | `str \| None` | Configuración stateful serializada en JSON. |
| `execution_config` | `str` | Configuración de ejecución en JSON (headers ya sanitizados). |
| `engine_version` | `str \| None` | Versión del engine que produjo el análisis (solo provenance). |

### `AnalysisEndpointRecord`
Resumen filtrable de qué endpoints ataca un análisis (no los valores probados — esos viven en la traza grabada como artefacto).

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `analysis_id` | `int` | **Foreign Key** referenciando a `AnalysisRecord.id`. |
| `method` | `str` | El método HTTP (ej. `GET`, `POST`). |
| `path` | `str` | La URL (ej. `/api/v1/users`). |

### `RunRecord`
Una corrida: una ejecución concreta de un análisis.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `analysis_id` | `int` | **Foreign Key** referenciando a `AnalysisRecord.id`. |
| `executed_at` | `datetime` | Momento en que arrancó la corrida. |
| `duration_ms` | `int \| None` | Duración total de la corrida en milisegundos. |
| `executed_against_repo_hash` | `str` | Hash del repo contra el que efectivamente se ejecutó. |
| `status` | `str` | Resultado materializado de la corrida (ej. `SUCCESS`, `FAILED`). |
| `ordinal` | `int` | Posición de la corrida dentro de su análisis (1 = original). |
| `is_original` | `bool` | Si esta corrida generó y grabó la traza. |

### `RunMetricsRecord`
Stats agregadas de una corrida. Sin columnas de coverage: el engine todavía no lo emite.

| Campo | Tipo | Descripción |
|---|---|---|
| `run_id` | `int` | **Foreign Key** (y Primary Key) referenciando a `RunRecord.id`. |
| `total_requests` | `int` | Total de requests enviados durante la corrida. |
| `findings_raw` | `int` | Violaciones encontradas en exploración, antes de shrinking. |
| `findings_confirmed` | `int` | Findings que reprodujeron al shrinkear. |
| `findings_unique` | `int` | Defectos distintos (`== len(crash_reports)`). |
| `findings_flaky` | `int` | Findings que no reprodujeron. |
| `by_phase` | `str \| None` | Desglose de requests por fase, serializado en JSON. |
| `by_category` | `str \| None` | Desglose de requests por categoría de error, en JSON. |

### `RunEndpointStatsRecord`
Detalle por endpoint de las stats de una corrida.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `run_id` | `int` | **Foreign Key** referenciando a `RunRecord.id`. |
| `analysis_endpoint_id` | `int` | **Foreign Key** referenciando a `AnalysisEndpointRecord.id`. |
| `requests` | `int` | Requests enviados contra este endpoint durante la corrida. |
| `findings_raw` | `int` | Violaciones encontradas para este endpoint, antes de shrinking. |
| `crash_count` | `int` | Conteo materializado de filas de `crash_reports` de este endpoint (no una copia). |

### `CrashReportRecord`
Un defecto distinto encontrado en una corrida.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `run_id` | `int` | **Foreign Key** referenciando a `RunRecord.id`. |
| `analysis_endpoint_id` | `int \| None` | **Foreign Key** a `AnalysisEndpointRecord.id`; `None` si el hallazgo abarca varios endpoints (stateful). |
| `method` / `path` / `phase` | `str` | Identidad del request que disparó el defecto y su fase (valid/boundary/invalid/attack/stateful). |
| `invariant_violated` | `str` | Qué invariante se violó. |
| `status_code` | `int` | Código de status de la respuesta que falló. |
| `minimal_payload` | `str` | Payload mínimo reproducible, en JSON. |
| `sanitized_headers` | `str` | Headers en JSON, con secretos ya redactados por el engine. |
| `response_body` | `str` | Cuerpo de la respuesta que falló. |
| `stack_trace` | `str \| None` | Lo completa después el Auto-Fixer; el engine lo deja en `None`. |
| `transition_sequence` | `str \| None` | Cadena de requests en JSON, solo para hallazgos stateful. |

### `ArtifactRecord`
Un artefacto de recipe (a nivel análisis, ej. la traza) o de reporte (a nivel corrida, ej. `report.html`). Pertenece a exactamente uno de los dos niveles — lo garantiza un `CHECK` en el schema, no solo el repositorio.

| Campo | Tipo | Descripción |
|---|---|---|
| `id` | `int` | Primary Key de la tabla autoincremental. |
| `analysis_id` | `int \| None` | Seteado en artefactos de nivel análisis. |
| `run_id` | `int \| None` | Seteado en artefactos de nivel corrida. |
| `kind` | `str` | Tipo de artefacto (ej. `execution_trace`, `report_html`). |
| `path` | `str` | Ruta en disco del artefacto. |
| `sha256` | `str` | Hash del contenido del artefacto. |
| `size_bytes` | `int` | Tamaño en bytes. |
| `critical` | `bool` | Si perderlo rompe la reproducibilidad. |
| `compressed` | `bool` | Si está almacenado comprimido. |

---

## Testing

El módulo incluye soporte nativo para bases de datos **en memoria**, facilitando el testing aislado. Los repositorios pueden inyectarse con un `StorageEngine(db_path=":memory:")` y compartir la misma conexión durante los tests unitarios.

Para correr la suite de pruebas del storage de forma completamente aislada con Docker:

```bash
cd lib/storage
docker build -t storage-engine .
docker run --rm storage-engine pytest -v --cov=src/storage --cov-report=term-missing
```
