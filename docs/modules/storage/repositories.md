# Repositories

Each of the ten tables has one repository, a Data Access Object that holds all of
that table's SQL. Every repository takes a `sqlite3.Connection`; in practice you
get them from a `UnitOfWork` (see [transactions](transactions.md)), so they write
inside the caller's scope.

## The contract { #the-contract }

The repositories package states the contract every repository follows:

> No repository commits: the transaction owner does. `create()` takes a transient
> record; one already carrying a database-assigned field raises
> `PersistedRecordError`. It raises `DuplicateRowError` on a UNIQUE or PRIMARY KEY
> violation and `ConstraintViolationError` on any other constraint violation.

## Transient records

A record is *transient* while every field the database assigns is `None`. Which
fields those are depends on the table:

| Table | Database-assigned fields |
|---|---|
| `analyses` | `id`, `created_at` |
| `runs` | `id`, `executed_at` |
| `run_metrics` | none: its key is the `run_id` you pass |
| every other table | `id` |

`PersistedRecordError` carries the record's type name as `record_type` and the
offending fields as `assigned`. Since `run_metrics` assigns nothing, its
`create()` never raises it.

`create()` returns the new row's id. The exception is `RunMetricsRepository.create`,
which returns `None`, because the row's key is the run id you passed. Projects
have no `create()` at all: `get_or_create(record)` returns the stored
`ProjectRecord` ([below](#get-or-create)).

## How a repository is built

Each repository declares one `TableMapping` for its table. The mapping derives,
from the record's fields, the table's columns, the insertable columns (all of
them minus the database-assigned ones), the select list and the INSERT
statement. Column order is field order.

A nested record is flattened. `RunEndpointStatsRecord.latency` is a
`LatencyRecord`, declared with `embedded=("latency",)`: it is stored as seven
`latency_*` columns and re-nested when the row is read.

An INSERT that violates a constraint is translated with the table name, so the
error says which table refused the row. Why the columns are derived rather than
written by hand: [ADR-078](adr/repositories.md#adr-078).

## Where validation lives

Domain rules are checked in `create()`, before the INSERT, and raise typed
exceptions:

| Table | Rule checked by `create()` | Exception |
|---|---|---|
| `runs` | `status` is in `RUN_STATUSES` | `InvalidRunStatusError` |
| `runs` | `oracle_scope` is in `ORACLE_SCOPES` | `InvalidOracleScopeError` |
| `runs` | `truncation_reason` and `truncation_endpoint_id` are both set or both null | `IncompleteTruncationError` |
| `runs` | `truncation_detail` and `target_down_verdict` are null when there is no truncation reason | `TruncationQualifierWithoutReasonError` |
| `analysis_endpoints` | `disposition` is in `ENDPOINT_DISPOSITIONS` | `InvalidDispositionError` |
| `analysis_endpoints` | `exclusion_reason` is set exactly when the disposition is `excluded` | `IncompleteExclusionError` |
| `run_endpoint_stats` | `held_back_by` and `held_back_via` are both set or both null | `IncompleteHoldError` |
| `run_endpoint_stats` | `truncation_detail` is null when there is no truncation reason | `TruncationQualifierWithoutReasonError` |
| `run_producer_exclusions` | `disposition` is in `PRODUCER_EXCLUSION_DISPOSITIONS` | `InvalidDispositionError` |

`RunRepository.create` checks in the order of the table: status, then oracle
scope, then the reason and endpoint pair, then the qualifiers. A second run with
the same `(analysis_id, ordinal)` raises `DuplicateRunError`, which carries both.

The vocabularies are listed in
[closed vocabularies](data-model.md#closed-vocabularies); what each run status
means to a reader is on [result vocabularies](../core/protocol/vocabularies.md#run-status).
Each one is enforced twice, by the table's CHECK and by `create()`
([ADR-080](adr/repositories.md#adr-080)).

`ArtifactRepository.create` does not pre-check the artifact's level. The schema's
CHECK refuses a row with both or neither of `analysis_id` and `run_id` set, as a
`ConstraintViolationError`. Use `save_artifact`, which checks the level first.

`FindingRecord` is the one record with a model validator: a `confirmed` finding
without `status_code`, `minimal_payload`, `sanitized_headers` and
`response_body` cannot be built. The error is pydantic's `ValidationError`, not
a storage exception. Why every other rule lives in `create()`:
[ADR-079](adr/repositories.md#adr-079).

## Projects: get_or_create { #get-or-create }

`get_or_create(record)` first checks the record is transient, so even a project
that already exists rejects a record carrying an `id`. It then looks the project
up by `(name, repo_path)`. When there is no match, it inserts with
`ON CONFLICT (name, repo_path) DO NOTHING` and reads the row back. A writer that
loses a race to register the same project gets the winner's row
([ADR-081](adr/repositories.md#adr-081)).

## Reference { #reference }

Every `create()` can also raise the three errors of [the contract](#the-contract);
the *Raises* column lists only the others.

| Repository | `UnitOfWork` property | Method | Returns | Raises |
|---|---|---|---|---|
| `ProjectRepository` | `projects` | `get_or_create(record)` | `ProjectRecord`, stored or inserted | `PersistedRecordError` |
| | | `get_by_id(project_id)` | `ProjectRecord` | `ProjectNotFoundError` |
| | | `list_all()` | `list[ProjectRecord]` by name (case-insensitive), then id | — |
| `AnalysisRepository` | `analyses` | `create(record)` | `int` | — |
| | | `get_by_id(analysis_id)` | `AnalysisRecord` | `AnalysisNotFoundError` |
| | | `list_by_project(project_id)` | `list[AnalysisRecord]` by creation time, then id | — |
| | | `count_by_project(project_ids)` | `dict[int, int]`; a project with none maps to 0, an empty input gives `{}` | — |
| `AnalysisEndpointRepository` | `analysis_endpoints` | `create(record)` | `int` | `InvalidDispositionError`, `IncompleteExclusionError` |
| | | `get_by_id(analysis_endpoint_id)` | `AnalysisEndpointRecord` | `AnalysisEndpointNotFoundError` |
| | | `list_by_analysis(analysis_id)` | `list[AnalysisEndpointRecord]`, every disposition | — |
| | | `find_by_method_path(analysis_id, method, path)` | `AnalysisEndpointRecord` of any disposition, or `None` | — |
| | | `count_by_disposition(analysis_ids)` | `dict[int, dict[str, int]]`; every disposition present, missing counts 0 | — |
| `AnalysisEndpointContractRepository` | `analysis_endpoint_contracts` | `create(record)` | `int` | — |
| | | `list_by_analysis(analysis_id)` | `list[ProducedContractRecord]` by method, then path | — |
| `RunRepository` | `runs` | `create(record)` | `int` | `InvalidRunStatusError`, `InvalidOracleScopeError`, `IncompleteTruncationError`, `TruncationQualifierWithoutReasonError`, `DuplicateRunError` |
| | | `get_by_id(run_id)` | `RunRecord` | `RunNotFoundError` |
| | | `list_by_analysis(analysis_id, run_filter=None)` | `list[RunRecord]` by ordinal | — |
| | | `count_by_analysis(analysis_ids)` | `dict[int, int]`; an analysis with none maps to 0 | — |
| | | `get_max_ordinal(analysis_id)` | `int`, 0 when the analysis has no runs | — |
| `RunMetricsRepository` | `run_metrics` | `create(record)` | `None` | — |
| | | `get_by_run_id(run_id)` | `RunMetricsRecord` | `RunMetricsNotFoundError` |
| `RunEndpointStatsRepository` | `run_endpoint_stats` | `create(record)` | `int` | `IncompleteHoldError`, `TruncationQualifierWithoutReasonError` |
| | | `get_by_id(run_endpoint_stats_id)` | `RunEndpointStatsRecord` | `RunEndpointStatsNotFoundError` |
| | | `list_by_run(run_id)` | `list[RunEndpointStatsRecord]` | — |
| `FindingsRepository` | `findings` | `create(record)` | `int` | — |
| | | `get_by_id(finding_id)` | `FindingRecord` | `FindingNotFoundError` |
| | | `list_by_run(run_id)` | `list[FindingRecord]`, every state | — |
| | | `count_by_state(run_id)` | `dict[str, int]`; states with no findings are absent | — |
| `RunProducerExclusionsRepository` | `producer_exclusions` | `create(record)` | `int` | `InvalidDispositionError` |
| | | `list_by_run(run_id)` | `list[RunProducerExclusionRecord]` by id | — |
| `ArtifactRepository` | `artifacts` | `create(record)` | `int` | — |
| | | `get_by_id(artifact_id)` | `ArtifactRecord` | `ArtifactNotFoundError` |
| | | `list_by_analysis(analysis_id)` | `list[ArtifactRecord]` | — |
| | | `list_by_run(run_id)` | `list[ArtifactRecord]` | — |
| | | `list_all()` | `list[ArtifactRecord]` by id | — |
| | | `count_by_analysis(kind, analysis_ids)` | `dict[int, int]` of analysis-level artifacts of that kind; none maps to 0 | — |
| | | `mark_compressed(artifact_id, *, path, size_bytes)` | `None` | `ArtifactNotFoundError` when no row matched |
| | | `delete(artifact_id)` | `None`; the file on disk is the caller's to remove | `ArtifactNotFoundError` when no row matched |

`RunFilter` narrows `RunRepository.list_by_analysis`. Every field is optional,
and the ones you set combine:

| Field | Keeps |
|---|---|
| `status` | runs with exactly this status |
| `executed_since` | runs executed on or after this UTC calendar date |
| `endpoint_path` | runs whose per-endpoint stats include an endpoint with this path |
| `limit` | at most this many runs; at least 1 |

## Recipes

### Add a table

1. Write the table's DDL in `src/storage/schema.sql`.
2. Add its record to `src/storage/models/<domain>.py`, one field per column, with
   the database-assigned fields defaulting to `None`, and re-export it from
   `models/__init__.py`.
3. Add `src/storage/repositories/<table>_repository.py`: declare
   `_TABLE = TableMapping("<table>", <Record>)` (pass `assigned=` or `embedded=`
   when the defaults do not fit), let `create()` return
   `_TABLE.insert(self._conn, record)`, and build every read from
   `_TABLE.select_list` and `_TABLE.to_record(row)`.
4. Add a property for the repository to `UnitOfWork` in `src/storage/db.py`.
5. Export the record and the repository from `src/storage/__init__.py`.
6. Add the table's `TableMapping` to `tests/test_schema_parity.py` and the new
   names to `tests/test_public_api.py`. The parity test fails until the table has
   a mapping whose columns match the DDL; the public-API test fails until the
   names are exported.
7. Delete your local databases: the schema text changed, so the
   [fingerprint](data-model.md#fingerprint) changed and an existing file refuses to
   open with `SchemaMismatchError`.

### Add a value to a closed vocabulary

1. Add the value to its tuple: `RUN_STATUSES` or `ORACLE_SCOPES` in
   `src/storage/models/run.py`, `ENDPOINT_DISPOSITIONS` in
   `src/storage/models/analysis.py`.
2. Add the same value to the table's CHECK in `src/storage/schema.sql`.
3. Leave `create()` alone: it already reads the tuple.
4. Run the run repository's tests: they write every value of `RUN_STATUSES` and
   `ORACLE_SCOPES` through the CHECK, so a value added to one place but not the
   other fails there.
5. Delete your local databases: the schema text changed, so the fingerprint
   changed.
6. If the value is a run status, describe what it means to a reader on
   [result vocabularies](../core/protocol/vocabularies.md#run-status).
