# Run Report

Every run saved through the [storage engine](../modules/storage/index.md) - `fuzz` or
`replay` - leaves a run report: the same document rendered three ways, so a
`report.json` pulled off disk, the panels `inspect --run <id>` prints, and the
object `--json-output` writes to stdout never disagree about what a run found.

## What a run leaves

Alongside the execution trace, a saved run writes two run-level artifacts:

| Kind | Filename | Contents |
| --- | --- | --- |
| `report_json` | `report.json` | The document below, as canonical JSON. |
| `report_html` | `report.html` | A self-contained, shareable HTML page rendering the same document. |

Both live under `data/artifacts/runs/<run_id>/`, indexed in the `artifacts`
table like the trace - see the [data model](../modules/storage/data-model.md) for the
`ArtifactRecord` shape and the content-addressed storage scheme.

Neither file is critical, unlike the trace: both are derivable from data
already in the database, so losing one never threatens reproducibility. A
fuzz run's report regenerates byte-for-byte from its persisted metrics,
endpoint stats and crashes; a replay's report additionally needs the
verdicts, which are not persisted, so regenerating it means running `replay`
again - cheap and deterministic, which is the point of the command.

The document carries no generation timestamp - the only temporal fact it
carries is the run's own `executed_at` - so rebuilding the same run's report
is byte-identical, and a byte-identical rebuild is recognized as the file
already on disk instead of writing a duplicate.

Being heavy and regenerable is exactly what makes the report pair the
primary target of [`prune`](cli-reference.md): a retention pass deletes old
reports first (after showing its plan and asking), while the critical trace
is only ever compressed - or deleted under the explicit `--include-traces`
consent. Deleting a run's reports removes nothing the database still holds:
its metrics, endpoint stats and crashes stay queryable through `history` and
`inspect`.

## The `report.json` schema

`ReportDocument` is a frozen, `extra="forbid"` Pydantic model: a pure function
of a run's persisted data, never a live object. It carries a `schema_version`
("1.1" today), bumped when the shape changes in a way a reader cannot ignore.
1.1 is additive over 1.0: it adds `run.signal`/`run.signal_causes`,
`coverage`, and `endpoints[].examples_planned`.

| Field | Description |
| --- | --- |
| `tool` | Which tool produced the document (`name`), and the engine version that ran the analyzed API. |
| `project` | The analyzed project's name. |
| `analysis` | The recipe the run executed: id, label, strategy mode, whether it was stateful, and the repo hash it was generated against. |
| `run` | The run's own identity and outcome: id, ordinal, origin (original/replay), `executed_at`, duration, `status`, `fidelity`, its comparability mark, `signal`/`signal_causes` (see below), and - when the run was cut short - `truncation` (`reason` plus `endpoint_id`), otherwise `null`. |
| `metrics` | The finding funnel and request counters, `null` when a run recorded none. |
| `endpoints` | One entry per endpoint touched: requests, `examples_planned`, raw findings, crash count and its latency distribution. |
| `coverage` | The declared-endpoint partition behind the run - `declared`/`targeted`/`excluded`/`filtered`/`exercised` counts plus `excluded_endpoints` (method, path, reason) - `null` for a replay, which never compiles. |
| `defects` | One entry per crash, ordered most-severe-first (the same order the live crash tables render): identity, reproducer and what the run observed - the same shape `inspect --crash <id>` and `compare` project a crash through. |
| `replay` | What only a replay knows - fidelity, divergences and a verdict per recorded defect - `null` for an original run. |

`run.signal` is `"clean"` or `"degraded"`, `null` for a replay (coverage is a
compilation-time fact a replay never produces, so trustworthiness there is
read from `fidelity` instead); `run.signal_causes` lists why when degraded -
`no_responses`, `endpoints_excluded` and/or `endpoints_unreached`. See
[Coverage and the run's signal](cli-reference.md#coverage-and-the-runs-signal) for
what each cause means and how it is derived.

`run.truncation` and `run.status`/`run.fidelity` read from the same columns
`history` and `inspect --run <id>` already show; see the
[data model](../modules/storage/data-model.md) for `RunRecord`'s full field list and
the closed status vocabulary.

## Machine output: `--json-output`

`fuzz`, `replay`, `inspect`, `history`, `compare` and `prune` all accept
`--json-output` (see [CLI Reference](cli-reference.md)). It wraps the same building
blocks - the run report document, a single defect, a listing, a comparison -
in one envelope:

| Field | Description |
| --- | --- |
| `schema_version` | Same vocabulary as the report document's. |
| `command` | The command name that produced the envelope. |
| `status` | `"ok"` or `"error"`, never both. |
| `data` | The command's payload on success, `null` on error. |
| `error` | A stable `code` plus a human-readable `message`, `null` on success. |
| `warnings` | Non-fatal issues that rode along an otherwise-successful run - empty most of the time. |

Every key is present regardless of outcome - absent data is `null` or an
empty list, never a missing key - so a consumer can always index into a known
shape. A run whose fuzzing or replay succeeded but whose save to storage
failed still emits an `ok` envelope carrying the full document (`run.id` left
`null`), with the failure riding along as a `warnings` entry: a save failure
never discards the findings a run actually produced. A degraded `fuzz` run's
`ok` envelope carries that signal the same way, as a `warnings` entry coded
`degraded_signal` naming the cause - alongside a save failure's, if there is
one.

## Error codes

`error.code` is drawn from a fixed, versioned registry - one entry per domain
exception any service module can raise, kept complete by a test - plus three
fallbacks: `unexpected_error` for anything not in the registry,
`invalid_arguments` for a malformed invocation, and a per-command
`_unavailable` code for a missing dependency. New in this registry:
`no_matching_endpoints` (the `--endpoint`/`--method` filters selected no
endpoint), `coverage_accounting_failed` (the declared-endpoint partition
doesn't add up), `fuzz_no_compilable_endpoints` (every selected endpoint was
excluded, so `fuzz` refuses before sending anything), `fuzz_contract_producer`
(a `--contracts` fixture could not be loaded, declares another endpoint, or was
rejected by fusion),
`replay_url_credentials_missing` and `replay_target_mismatch` (`replay
--base-url` missing or pointed at a different host than the trace was recorded
against). A refusal caught before any exception is raised - a missing library,
bad flags - is reported through the same envelope, never a bare panel or a
silent exit. Codes are stable across releases; a breaking change to the
registry bumps `schema_version`.
