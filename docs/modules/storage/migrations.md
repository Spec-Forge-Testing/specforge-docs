# Schema versions and migrations

Storage builds its database with numbered, forward-only SQL scripts, and SQLite's
`user_version` records the version a file is at. Opening a `StorageEngine` brings
the file to the latest version before anything else runs. The scripts live in
`src/storage/migrations/`; the runner is `StorageEngine._initialize_schema` in
`db.py` ([ADR-193](adr/foundations.md#adr-193)).

## The scripts

`NNNN_<name>.sql` takes a database from version `NNNN - 1` to `NNNN`. They are
numbered from `0001` with no gap; `load_migrations` refuses a gap, and ignores a
file outside the naming.

| Version | Script | What it changes |
| --- | --- | --- |
| 1 | `0001_initial.sql` | The eleven tables of the run hierarchy and the contract cache. |
| 2 | `0002_finding_explanations_and_fixes.sql` | `analyses.repo_root`; the tables `finding_explanations` and `finding_fixes`. |
| 3 | `0003_finding_fix_applied.sql` | `finding_fixes.applied_at`. |
| 4 | `0004_endpoint_phase_breakdown.sql` | The four phase maps of `run_endpoint_stats`. |
| 5 | `0005_finding_evidence.sql` | The ten evidence columns of `findings`, without `stack_trace`; `run_metrics.findings_refuted`. |
| 6 | `0006_strategy_canonical.sql` | The canonical strategy names; `analyses.examples_per_endpoint`. |
| 7 | `0007_finding_server_logs.sql` | The table `finding_server_logs`. |
| 8 | `0008_finding_fix_build_failure.sql` | `finding_fixes.build_output` and `build_failed_at`. |
| 9 | `0009_finding_notes.sql` | The table `finding_notes`. |
| 10 | `0010_finding_resolutions.sql` | The table `finding_resolutions`. |
| 11 | `0011_strategy_column_and_cut_without_endpoint.sql` | `analyses.strategy_mode` renamed `strategy`; `runs` rebuilt so a `flaky_generation` cut records no endpoint. |
| 12 | `0012_replay_defect_verdicts.sql` | The table `replay_defect_verdicts`; `runs.replay_recorded_defects`. |
| 13 | `0013_finding_replay_request_recorded.sql` | `findings.replay_request_recorded` and `replay_matcher_version`. |
| 14 | `0014_producer_exclusion_cause.sql` | `run_producer_exclusions.cause`. |

The tables and their columns, as the latest version leaves them, are on
[Data model](data-model.md) and [Finding follow-up records](finding-records.md).

## Opening a file

| The file | What opening it does |
| --- | --- |
| No tables yet, or `:memory:` | Runs every script. |
| At an older version | Runs the scripts it is missing. |
| At the latest version | Runs nothing. |
| At a version above the latest | Raises `SchemaTooNewError` (`db_path`, `found_version`, `supported_version`) and leaves the file untouched: the release that wrote it still opens it. |
| A stamp no version matches | Built before versioned migrations from another shape: the file and its `-wal` and `-shm` companions are renamed `<name>.old-<UTC timestamp>` beside it, never deleted, and a fresh database takes its place. `StorageEngine.set_aside_path` says where it went. |

The missing scripts run in one write transaction, with foreign keys off so a
script can rebuild a table, and the version is read again once the write lock is
held, since another process may have migrated the file meanwhile. A foreign-key
check runs before the commit; a failure rolls everything back and leaves the file
at the version it had. `StorageEngine.schema_version` reads the version without
changing anything, and `storage.inspection` reports a file's state (`missing`,
`current`, `older`, `newer`, `unrecognized`) for diagnostics.

Version 1 is stamped with the checksum releases before versioned migrations
wrote, so a file from then opens with its rows and migrates
on, and those releases still open a file at version 1. Any version above it is
stamped with its own number.

## Adding a migration

1. Add `src/storage/migrations/NNNN_<what_it_does>.sql`, the next number. Start it
   with a comment saying what the version changes; a column's meaning goes in a
   comment beside it.
2. Change the record DTOs in `src/storage/models/` to the new shape, one field per
   column in table order.
3. Run the storage suite. `tests/test_schema_parity.py` compares the migrated
   schema with the records; `tests/test_migrations.py` checks that a file at every
   released version reaches the shape of a fresh one, and that no released script
   changed.

**A released script is never edited.** A change of shape is a new script, so a
database built by any earlier release reaches the current shape by running the
scripts it lacks. SQLite cannot alter a CHECK: a script that changes one rebuilds
the table, as `0011` rebuilds `runs`.
