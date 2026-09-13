<div style="display: flex; align-items: center; gap: 1rem; margin-bottom: 0;">
  <img src="assets/imgs/mascot.jpeg" alt="Sledge, the Spec Forge mascot" width="72" style="border-radius: 12px; margin: 0;">
  <h1 style="margin: 0;">Spec Forge</h1>
</div>

<figure style="text-align: center; margin: 3rem 0;">
  <img src="assets/imgs/spec-forge.png" alt="Spec Forge CLI running in a terminal" width="800">
</figure>

Spec Forge finds bugs in your API. You give it your API's OpenAPI description — and,
optionally, its source code — and it generates a stream of requests against a running copy of
the API, checking rules that must always hold: no unexpected server errors, responses that
match the schema, no undeclared status codes, and the business rules it can read from your
code. When a request breaks a rule, Spec Forge shrinks it to the smallest example that still
fails and saves the result so you can reproduce it exactly.

---

## How it works

```mermaid
%%{init: {"flowchart": {"curve": "linear"}, "themeVariables": {"fontSize": "18px"}} }%%
flowchart TD
    classDef file fill:transparent,stroke:#8a8a8a,stroke-width:1px,stroke-dasharray:4 4;
    classDef engine fill:transparent,stroke:#a855f7,stroke-width:2px;
    classDef action fill:transparent,stroke:#5d87ff,stroke-width:2px;
    classDef result fill:transparent,stroke:#e11d48,stroke-width:1px;

    A[your OpenAPI spec]:::file --> C(read the contract):::engine
    B[your source code]:::file --> D(read the code):::engine

    C --> E(infer business rules<br/>optional):::engine
    D --> E

    C --> F{merge into one contract}:::engine
    E --> F

    F --> G([generate and send requests]):::action
    G --> H[findings, saved and replayable]:::result
```

---

## Start here

<div class="grid cards sf-start-here" markdown>

-   :material-rocket-launch-outline:{ .lg .middle } __I want to test my API__

    ---

    - [Installation & Quick Start](user-guide/installation.md) — prerequisites and your first run.
    - [Core Concepts](user-guide/concepts.md) — what Spec Forge does and the words it uses.
    - [CLI Reference](user-guide/cli-reference.md) — every command, its flags and its output.
    - [Example Walkthrough](user-guide/example-walkthrough.md) — the commands end to end
      against a sample API.

-   :material-hammer-wrench:{ .lg .middle } __I want to understand or extend the code__

    ---

    - [Architecture Overview](architecture/overview.md) — the pipeline stages and how they
      fit together.
    - [Data Flow](architecture/data-flow.md) — the typed objects that cross between modules.
    - [Developer Guide › Modules](modules/contract-engine/index.md) — a per-package
      implementation deep dive.

</div>
