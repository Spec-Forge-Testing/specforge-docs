# Contract Engine — Decision records

Decisions taken while building `contract_engine` that are not obvious from
reading the code, and that someone would otherwise be tempted to undo. Each
record states the situation that forced the decision, what was decided, and what
it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.
Numbers continue the series started by the [Core AST records](../../core-ast/adr/index.md):
they are unique across the whole site, so a number always names one decision.

!!! info "The rule these decisions answer to"
    **A contract that resolves is a contract this stage can deliver.** The
    corpora are published, working APIs; when one of them does not ingest, the
    defect is ours until proven otherwise. A finding that does not prevent
    building the contract is reported on `deviations` rather than rejecting the
    spec — rejecting costs every endpoint the document describes correctly.

## Where a decision lives

| File | Stage | Covers |
| --- | --- | --- |
| [ingestion.md](ingestion.md) | ingestion | Loading, resolving and judging the document: `$ref` pointers, cycles, conformance |

## Full index

| | Stage | Decision |
| --- | --- | --- |
| [ADR-052](ingestion.md#adr-052) | ingestion | A `$ref` that names nothing is pruned and reported, not raised over |
| [ADR-053](ingestion.md#adr-053) | ingestion | A truncated cycle's marker carries `x-recursive` |
| [ADR-054](ingestion.md#adr-054) | ingestion | A validator that cannot run reports instead of deciding the verdict |
