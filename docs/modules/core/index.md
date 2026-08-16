# Core CLI (`specforge_cli`)

The CLI is the interactive entry point to Spec Forge. It coordinates contract
validation, static tracing, LLM-ready context extraction and API fuzzing without
putting domain logic in the user interface.

## Commands Summary

| Command | Category | Description |
| :--- | :--- | :--- |
| **`doctor`** | Diagnostics | Checks environment, pipeline dependencies, and LLM setup. |
| **`doctor --fix`** | Diagnostics | Guided automated installation and dependency fixes. |
| **`trace`** | Analysis | Static code tracing from an OpenAPI endpoint. |
| **`ast-extract`** | Analysis | Inspects extracted code structures and LLM context. |
| **`fuzz`** | Execution | Compiles strategies from schema and fuzzes a live API. |
| **`replay`** | Execution | Re-sends an analysis's recorded trace and rules a verdict per defect. |
| **`history`** | History | Browses persisted projects, analyses and runs, with filters. |
| **`inspect`** | History | Shows one run in full (metrics, latency, crashes, artifacts), or one crash in full (payload, headers, response body). |
| **`!`** | System | Executes system shell commands directly from REPL. |
| **`theme`** | Settings | Switches the CLI UI color theme. |

## Start here

Run `specforge` to open the REPL. The complete syntax, options, architecture,
workspace walkthrough and test instructions are in [Commands](commands.md).

The CLI delegates to `contract-engine`, `core-ast` and Custom Schemathesis; see
their module pages for the corresponding implementation details.
