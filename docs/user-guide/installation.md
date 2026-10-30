# Installation & Quick Start

## Prerequisites

- Python 3.11+ for the CLI. `specforge-contracts` supports Python 3.10+.
- Docker and Docker Compose only for the [containerized workflow](docker.md).
- An LLM model and its provider key only for a run with the inference producer, which infers
  each endpoint's contract from its source code; fuzzing from the spec alone needs none. That
  producer also needs `lib/llm` and `lib/semantic_inference` installed. See
  [LLM Providers](llm-providers.md).
- To read source code in Java, C#, Ruby, PHP, Rust, Kotlin or Swift, the `golden-path` extra of
  `lib/core_ast`: `pip install -e "lib/core_ast[golden-path]"`. Python, JavaScript, TypeScript
  and Go need nothing extra.

## Quick start

Install the packaged frontend in the environment where you want to run it:

```bash
pip install specforge-cli
```

Create or open a target project, then start the interactive shell:

```bash
specforge init_project --path ./my-api --openapi-spec ./my-api/openapi.yaml
specforge
```

Inside the shell, `help` lists the operations published by the core. The
[Spec Forge CLI guide](specforge-cli.md) covers the interactive interface and
the one-shot form used by scripts and CI. For a guided tour of the packaged
client, start with [Interactive use](cli/interactive.md) or
[Scripts, CI and approvals](cli/scripts-and-ci.md).

The old core REPL is still available in the `llm-pbt-agent` checkout. It is a
developer tool with a different command set; see the [Core REPL Reference](cli-reference.md)
and [Core REPL walkthrough](example-walkthrough.md) when working on the core itself.

To run Spec Forge in containers instead, see [Running with Docker](docker.md). To
work on Spec Forge itself, see
[Contributing & Testing](../developer-guide/contributing.md).
