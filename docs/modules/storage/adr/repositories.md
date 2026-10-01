# Storage — Decision records — Repositories

Part of the [Storage decision records](index.md). Decisions about tables and
their records: where a table's columns come from, where a domain rule is
checked, how a closed set of values is kept closed, and how a project is
registered without a race.

---

## ADR-078 — A repository takes the record, and `TableMapping` derives its columns from it { #adr-078 }

**Status:** accepted · `repositories/_mapping.py`, `tests/test_schema_parity.py`

### Context

Each table's columns appear in its DDL, in its record, and in its INSERT and
SELECT statements. Four hand-kept lists drift, and a drift shows up as a wrong
value read back, not as an error.

### Decision

`TableMapping` derives the column list, the insertable columns, the select list
and the INSERT statement from the record's fields. A nested record (`latency`
on the endpoint stats) is flattened into prefixed columns (`latency_<field>`)
on write and re-nested on read. A test compares every table's real columns with
the ones its mapping derives, in both directions, and checks that every table
of the schema has a mapping.

### Rejected

Hand-written SQL per repository — the four lists. An ORM, which adds a
dependency and a second model layer for ten tables, and takes the SQL away from
where it runs.

### Consequences

Adding a field to a record without its column, or a column without its field,
fails the parity test. Column order is field order.

---

## ADR-079 — Domain rules are checked in `create()` with typed exceptions, not on the record { #adr-079 }

**Status:** accepted · `repositories/run_repository.py`, `repositories/analysis_endpoint_repository.py`, `repositories/run_endpoint_stats_repository.py`, `models/finding.py`

### Context

A rule such as "a truncation reason needs the endpoint it cut" could live on the
record (a pydantic validator), in the schema (a CHECK) or in the repository. A
validator raises pydantic's `ValidationError`, which is not a `StorageError`; a
CHECK raises a constraint error with SQLite's wording and no attributes.

### Decision

`create()` checks the rule before the INSERT and raises a typed exception
carrying the offending values (`IncompleteTruncationError`,
`TruncationQualifierWithoutReasonError`, `InvalidDispositionError`,
`IncompleteExclusionError`, ...). Records describe shape only. The one exception
is `FindingRecord`: a confirmed finding without its reproducer is not a finding
at all, so the record refuses to exist.

### Rejected

Validators on every record, whose errors fall outside the `StorageError`
family; and CHECK-only rules, whose errors are untyped and carry no attributes.

### Consequences

A record in memory can hold a value the table will refuse; the refusal arrives
at `create()`, typed. Building a confirmed `FindingRecord` without its
reproducer fields raises `ValidationError`.

---

## ADR-080 — Closed vocabularies are enforced twice: by a CHECK and by `create()` { #adr-080 }

**Status:** accepted · `models/run.py`, `models/analysis.py`, `schema.sql`

### Context

Run status, oracle scope and endpoint disposition are closed sets that readers
branch on. A row written by anything other than the repository would bypass a
Python-only check; a CHECK-only rule gives an untyped error.

### Decision

Each vocabulary is a tuple exported from `storage` (`RUN_STATUSES`,
`ORACLE_SCOPES`, `ENDPOINT_DISPOSITIONS`). Its table has a CHECK with the same
values, and `create()` rejects a value outside the tuple with a typed error
(`InvalidRunStatusError`, `InvalidOracleScopeError`, `InvalidDispositionError`).
The tests write every value of each tuple through its CHECK.

### Rejected

Either of the two alone, for the reasons above; and a lookup table with a
foreign key, which means rows to maintain for values that are code.

### Consequences

A new value is two edits: the tuple and the CHECK. Since the schema text
changes, so does the fingerprint ([ADR-076](foundations.md#adr-076)).

---

## ADR-081 — `get_or_create` is an insert that ignores the conflict, then a re-read { #adr-081 }

**Status:** accepted · `repositories/project_repository.py`

### Context

Two processes registering the same project at once race: a read-then-insert
lets both miss, and one of them fails on the UNIQUE constraint.

### Decision

The project is looked up by its natural key `(name, repo_path)`; if it is
absent, `INSERT … ON CONFLICT (name, repo_path) DO NOTHING` runs and the row is
read back. The loser of a race reads the winner's row. Projects have no
`create()`.

### Rejected

Catching the duplicate error and retrying, which drives control flow with a
driver error; and a `create()` that raises `DuplicateRowError` for an existing
project, which would make every caller handle a non-error.

### Consequences

Registering a project is idempotent and returns the stored record, not an id.
A record that already carries an id is still refused with
`PersistedRecordError`, even when the project exists.
