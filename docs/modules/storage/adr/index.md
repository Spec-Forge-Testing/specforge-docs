# Storage — Decision records

Decisions taken while building `storage` that are not obvious from reading the
code, and that someone would otherwise be tempted to undo. Each record states
the situation that forced the decision, what was decided, the alternative that
was rejected, and what it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.

!!! info "The rule these decisions answer to"
    **Storage answers in its own vocabulary: nothing driver-shaped leaves it,
    and nothing half-written stays.** A caller sees typed storage errors, never
    SQLite's or the operating system's; a composed write lands whole or not at
    all; and no row is ever left naming a file that is not on disk.

## Where a decision lives

The records are split by area. Numbers stay global across the whole site and are
never reused — the number tells you when it was written, the file tells you what
it governs. The sequence is shared by every module, so a number missing here
belongs to another one:
[ADR-074](../../core/adr/protocol.md#adr-074), for instance, is the core
protocol's.

| File | Area | Covers |
| --- | --- | --- |
| [foundations.md](foundations.md) | the engine | Error translation, the schema fingerprint, transaction scopes |
| [repositories.md](repositories.md) | tables and records | Derived columns, where validation lives, closed vocabularies, get-or-create |
| [artifacts.md](artifacts.md) | files on disk | Write order, retention, the filesystem gateway |

## Full index

| | Area | Decision |
| --- | --- | --- |
| [ADR-075](foundations.md#adr-075) | foundations | Every driver and OS error is translated at the boundary |
| [ADR-076](foundations.md#adr-076) | foundations | The schema carries a fingerprint; a mismatched file is refused, not migrated |
| [ADR-077](foundations.md#adr-077) | foundations | Transaction scopes do not nest, per engine and per thread |
| [ADR-078](repositories.md#adr-078) | repositories | A repository takes the record, and `TableMapping` derives its columns |
| [ADR-079](repositories.md#adr-079) | repositories | Domain rules are checked in `create()` with typed exceptions |
| [ADR-080](repositories.md#adr-080) | repositories | Closed vocabularies are enforced by a CHECK and by `create()` |
| [ADR-081](repositories.md#adr-081) | repositories | `get_or_create` inserts ignoring the conflict, then re-reads |
| [ADR-082](artifacts.md#adr-082) | artifacts | An artifact file is written before its row, at a content-addressed path |
| [ADR-083](artifacts.md#adr-083) | artifacts | Retention checks the transaction guard first and unlinks only after its own commit |
| [ADR-084](artifacts.md#adr-084) | artifacts | One filesystem gateway touches the disk, with the Windows extended-length prefix |
