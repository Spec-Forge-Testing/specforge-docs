# Installation & Quick Start

## Prerequisites

- Python 3.11+ for the repository and most modules. `specforge-contracts`
  supports Python 3.10+.
- Docker and Docker Compose for containerized workflows.
- A provider key only for semantic-inference integration tests; see
  [LLM Providers](llm-providers.md).

## Quick start

From the repository root, install the CLI and its development tools:

```bash
pip install -e core poethepoet ruff
poe setup-hooks
```

Initialize a target project, then start the interactive shell:

```bash
specforge init
specforge
```

Use [Docker Compose](docker.md) to run repository profiles, or
[Contributing & Testing](../developer-guide/contributing.md) to work on and
verify a module.
