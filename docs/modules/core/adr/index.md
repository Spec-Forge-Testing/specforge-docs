# Core — Decision records

Decisions taken while building the core that are not obvious from reading the
code, and that someone would otherwise be tempted to undo. Each record states
the situation that forced the decision, what was decided, the alternative that
was rejected, and what it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.

!!! info "The rule these decisions answer to"
    **The core is a black box: everything crosses an explicit contract, nothing
    by import.** No frontend reaches into the core, and the core reaches into no
    frontend; a client drives it over one channel and the core answers. When a
    shortcut would let two parties learn about each other any other way, the
    contract wins.

## Where a decision lives

The records are split by area. Numbers stay global across the whole site and are
never reused — the number tells you when it was written, the file tells you what
it governs. A number missing here belongs to another module.

| File | Area | Covers |
| --- | --- | --- |
| [core.md](core.md) | the headless core | Unprobed reasons, dependency gateways, the busy guard, cancelled-run evidence |
| [protocol.md](protocol.md) | the wire | How fixtures are captured, how versions are matched |

## Full index

| | Area | Decision |
| --- | --- | --- |
| [ADR-069](core.md#adr-069) | core | A targeted endpoint records why the run had nothing to probe |
| [ADR-070](core.md#adr-070) | core | One importer per optional library: the dependency gateways |
| [ADR-071](core.md#adr-071) | core | The busy guard registers only the operations that use the session |
| [ADR-072](core.md#adr-072) | core | A cancelled run keeps and persists its evidence |
| [ADR-073](protocol.md#adr-073) | protocol | Protocol fixtures are captured, not written |
| [ADR-074](protocol.md#adr-074) | protocol | Protocol versioning by exact equality, not negotiation |
