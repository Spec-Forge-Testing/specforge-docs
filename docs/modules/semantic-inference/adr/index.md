# Semantic Inference — Decision records

Decisions taken while building `semantic_inference` that are not obvious from
reading the code, and that someone would otherwise be tempted to undo. Each
record states the situation that forced the decision, what was decided, the
alternative that was rejected, and what it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.

!!! info "The rule these decisions answer to"
    **What the code or the OpenAPI document declares is handed to the model,
    never left for it to guess.** The model infers what only reading the code
    can tell; everything already written down reaches it as evidence.

## Where a decision lives

Numbers stay global across the whole site and are never reused — the number
tells you when it was written, the file tells you what it governs. A number
missing here belongs to another module.

| File | Area | Covers |
| --- | --- | --- |
| [prompts.md](prompts.md) | the contract prompt | What the prompt carries besides the handler's code |

## Full index

| | Area | Decision |
| --- | --- | --- |
| [ADR-093](prompts.md#adr-093) | prompts | The prompt carries the declared security requirement and request-type constraints |
