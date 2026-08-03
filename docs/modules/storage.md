# Storage Engine

`lib/storage` is the persistence layer for the Spec Forge pipeline. It turns the
tool into an auditable, centralized, traceable platform.

The engine manages a **SQLite** database inside the application directory
(`llm-pbt-agent/data/coretest.db`) organized around the **project → analysis → run**
hierarchy: an analysis is the replayable recipe (already-resolved contracts, a
recorded execution trace), and each run is one execution of that recipe — either
the original one, which generates and records it, or a later replay that resends it
as-is.

## Architecture (Repository pattern)

1. **`StorageEngine` (`db.py`)** — its only job is connecting to SQLite, configuring
   safety settings (e.g. enabling foreign keys), and initializing tables from the
   plain `schema.sql` file.
2. **Repositories (`repositories/`)** — one DAO per entity, fully encapsulating
   parametrized SQL (`INSERT`, `SELECT`) to shield the database against injection.
3. **DTOs (`models.py`)** — everything entering or leaving the engine is validated
   through immutable Pydantic models.
4. **Domain exceptions (`exceptions.py`)** — any persistence failure raises a
   handleable domain error (e.g. `RunNotFoundError`) instead of a raw SQLite driver
   exception.

## Data model

### `ProjectRecord`

The root record: which repository a set of analyses belongs to.

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `name` | `str` | Human-readable project name. |
| `repo_path` | `str` | Repository path on disk. |

### `AnalysisRecord`

The replayable recipe: resolved contracts, strategy mode, and execution config.

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `project_id` | `int` | Foreign key to `ProjectRecord.id`. |
| `created_at` | `datetime` | When the analysis was created. |
| `label` | `str \| None` | Optional human-readable label. |
| `generated_against_repo_hash` | `str` | Hash of the repo the trace was generated against. |
| `strategy_mode` | `str` | Hypothesis strategy mode used to generate it. |
| `stateful` | `bool` | Whether the analysis runs stateful chains. |
| `stateful_config` | `str \| None` | Stateful config, serialized as JSON. |
| `execution_config` | `str` | Execution config as JSON (headers already sanitized). |
| `engine_version` | `str \| None` | Engine version that produced the analysis (provenance only). |

### `AnalysisEndpointRecord`

A filterable summary of which endpoints an analysis targets (not the values tried —
those live in the recorded trace artifact).

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `analysis_id` | `int` | Foreign key to `AnalysisRecord.id`. |
| `method` | `str` | HTTP method (e.g. `GET`, `POST`). |
| `path` | `str` | URL (e.g. `/api/v1/users`). |

### `RunRecord`

A run: one concrete execution of an analysis.

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `analysis_id` | `int` | Foreign key to `AnalysisRecord.id`. |
| `executed_at` | `datetime` | When the run started. |
| `duration_ms` | `int \| None` | Total run duration, in milliseconds. |
| `executed_against_repo_hash` | `str` | Hash of the repo it actually ran against. |
| `status` | `str` | Final run outcome (e.g. `SUCCESS`, `FAILED`). |
| `ordinal` | `int` | Position of the run within its analysis (1 = original). |
| `is_original` | `bool` | Whether this run generated and recorded the trace. |

### `RunMetricsRecord`

Aggregate stats for a run. No coverage columns yet — the engine doesn't emit that data.

| Field | Type | Description |
|---|---|---|
| `run_id` | `int` | Foreign key (and primary key) to `RunRecord.id`. |
| `total_requests` | `int` | Total requests sent during the run. |
| `findings_raw` | `int` | Violations found during exploration, before shrinking. |
| `findings_confirmed` | `int` | Findings that still reproduced after shrinking. |
| `findings_unique` | `int` | Distinct defects (`== len(crash_reports)`). |
| `findings_flaky` | `int` | Findings that failed to reproduce. |
| `by_phase` | `str \| None` | Request breakdown by phase, as JSON. |
| `by_category` | `str \| None` | Request breakdown by error category, as JSON. |

### `RunEndpointStatsRecord`

Per-endpoint detail of a run's stats.

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `run_id` | `int` | Foreign key to `RunRecord.id`. |
| `analysis_endpoint_id` | `int` | Foreign key to `AnalysisEndpointRecord.id`. |
| `requests` | `int` | Requests sent to this endpoint during the run. |
| `findings_raw` | `int` | Violations found for this endpoint, before shrinking. |
| `crash_count` | `int` | Materialized count of this endpoint's `crash_reports` rows (not a copy). |

### `CrashReportRecord`

A distinct defect found during a run.

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `run_id` | `int` | Foreign key to `RunRecord.id`. |
| `analysis_endpoint_id` | `int \| None` | Foreign key to `AnalysisEndpointRecord.id`; `None` if the finding spans several endpoints (stateful). |
| `method` / `path` / `phase` | `str` | Identity of the request that triggered the defect, and its phase (valid/boundary/invalid/attack/stateful). |
| `invariant_violated` | `str` | Which invariant was violated. |
| `status_code` | `int` | Status code of the failing response. |
| `minimal_payload` | `str` | Minimal reproducible payload, as JSON. |
| `sanitized_headers` | `str` | Headers as JSON, with secrets already redacted by the engine. |
| `response_body` | `str` | Body of the failing response. |
| `stack_trace` | `str \| None` | Filled in later by the Auto-Fixer; the engine leaves it `None`. |
| `transition_sequence` | `str \| None` | Request chain as JSON, stateful findings only. |

### `ArtifactRecord`

A recipe-level artifact (analysis scope, e.g. the trace) or a report-level one
(run scope, e.g. `report.html`). Belongs to exactly one of the two levels — enforced
by a `CHECK` in the schema, not just by the repository.

| Field | Type | Description |
|---|---|---|
| `id` | `int` | Auto-incrementing primary key. |
| `analysis_id` | `int \| None` | Set for analysis-level artifacts. |
| `run_id` | `int \| None` | Set for run-level artifacts. |
| `kind` | `str` | Artifact type (e.g. `execution_trace`, `report_html`). |
| `path` | `str` | Path on disk. |
| `sha256` | `str` | Hash of the artifact's content. |
| `size_bytes` | `int` | Size in bytes. |
| `critical` | `bool` | Whether losing it breaks reproducibility. |
| `compressed` | `bool` | Whether it's stored compressed. |

## Testing

The module has native support for **in-memory** databases for isolated testing:
repositories can be injected with `StorageEngine(db_path=":memory:")` and share the
same connection across unit tests.

To run the storage suite fully isolated with Docker:

```bash
cd lib/storage
docker build -t storage-engine .
docker run --rm storage-engine pytest -v --cov=src/storage --cov-report=term-missing
```
