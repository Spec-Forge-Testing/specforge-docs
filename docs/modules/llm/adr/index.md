# LLM — Decision records

Decisions taken while building `llm` that are not obvious from reading the code,
and that someone would otherwise be tempted to undo. Each record states the
situation that forced the decision, what was decided, the alternative that was
rejected, and what it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.

!!! info "The rule these decisions answer to"
    **Every call ends in a named outcome, and every cost is either known or said
    to be unknown.** A failure is classified once and acted on the same way
    wherever it happens; an answer arrives in the shape the provider can
    produce; and a price the package does not know is never reported as zero.

## Where a decision lives

Numbers stay global across the whole site and are never reused — the number
tells you when it was written, the file tells you what it governs. A number
missing here belongs to another module.

| File | Area | Covers |
| --- | --- | --- |
| [llm.md](llm.md) | the LLM client | The failure policy, the structured-output mode per provider, the offline cost estimate |

## Full index

| | Area | Decision |
| --- | --- | --- |
| [ADR-090](llm.md#adr-090) | llm | Every failed attempt is classified once, and the class decides retry, fallback or stop |
| [ADR-091](llm.md#adr-091) | llm | The structured-output mode is chosen per provider from a table |
| [ADR-092](llm.md#adr-092) | llm | Cost is estimated without calling the model, and an unknown price is never free |
