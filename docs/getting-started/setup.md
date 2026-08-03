# Setup

## Prerequisites

- Python 3.11 or newer.
- Docker and Docker Compose.
- Optional API keys if you plan to use semantic inference against external models.

## Quick Start

Install the CLI in editable mode from the repository root:

```bash
pip install -e core poethepoet ruff
poe setup-hooks
```

Initialize Spec Forge in a target project:

```bash
specforge init
```

Start the interactive shell:

```bash
specforge
```

## Testing

Run the full suite across all modules:

```bash
poe test
```

Run a specific engine:

```bash
poe test-engine <engine-name>
# Example: poe test-engine storage-engine
```
