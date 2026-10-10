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

From the repository root, install the CLI:

```bash
pip install -e core
```

Initialize a target project, then start the interactive shell:

```bash
specforge init
specforge
```

Inside the shell, `help` lists every command; the [CLI Reference](cli-reference.md)
explains each one, and the [Example Walkthrough](example-walkthrough.md) runs them
end to end against a sample API.

To run Spec Forge in containers instead, see [Running with Docker](docker.md). To
work on Spec Forge itself, see
[Contributing & Testing](../developer-guide/contributing.md).
