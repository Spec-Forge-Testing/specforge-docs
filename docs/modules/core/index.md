# Core CLI (`specforge_cli`)

The CLI is the interactive entry point to Spec Forge. It coordinates contract
validation, static tracing, LLM-ready context extraction and API fuzzing without
putting domain logic in the user interface.

## Commands

| Command | Purpose |
|---|---|
| `contract-engine` | Validate and inspect an OpenAPI contract. |
| `trace` | Locate an endpoint implementation and trace its dependencies. |
| `ast-extract` | Inspect extracted source and the packaged LLM context. |
| `fuzz` | Compile contracts into strategies and test a live API. |
| `doctor` | Diagnose and optionally repair local dependencies. |
| `theme` | Select the terminal visual theme. |
| `!command` | Run an explicit system command from the REPL. |

## Start here

Run `specforge` to open the REPL. The complete syntax, options, architecture,
workspace walkthrough and test instructions are in [Commands](commands.md).

The CLI delegates to `contract-engine`, `core-ast` and Custom Schemathesis; see
their module pages for the corresponding implementation details.
