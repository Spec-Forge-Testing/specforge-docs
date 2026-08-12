# Storage Engine

`lib/storage` persists Spec Forge executions in SQLite so analyses can be audited,
compared and replayed. Its unit of organization is:

```mermaid
flowchart TD
    subgraph P ["1. Project"]
        direction LR
        P1["Repository Metadata"]
        P2["OpenAPI Spec"]
    end

    subgraph A ["2. Analysis"]
        direction LR
        A1["AST Context"]
        A2["LLM Invariants"]
        A3["Unified Contract"]
    end

    subgraph R ["3. Run"]
        direction LR
        R1["Fuzzing Seeds"]
        R2["Execution Logs"]
        R3["Shrinked Failures"]
    end

    P ==>|1:N| A
    A ==>|1:N| R
```

An **analysis** is the reproducible recipe (resolved contracts and execution settings);
a **run** is one execution of that recipe. Repositories encapsulate parameterized SQL,
Pydantic DTOs validate data at the boundary, and domain exceptions prevent SQLite
driver errors from leaking to callers. A composed multi-table write (persisting a run)
runs as one all-or-nothing transaction through a **Unit of Work** — see the
[data model](data-model.md#transactional-boundary-unit-of-work).

## Read next

- [Data model](data-model.md): every persisted record, relationship and test setup.
- [Custom Schemathesis](../custom-schemathesis/index.md): producer of execution
  results and crash reports.
- [Core commands](../core/commands.md): the `fuzz` command persists each run
  through this engine (on by default, `--no-save` to opt out).
