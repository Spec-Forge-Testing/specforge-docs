# Spec Forge

![Spec Forge CLI](assets/imgs/spec-forge.png)

Spec Forge is a modular, AI-powered Property-Based Testing (PBT) orchestrator for API security and
correctness testing. It combines static AST analysis, semantic inference, contract validation, and
fuzzing to discover deep bugs in web applications.

## Using Spec Forge

- [Installation & Quick Start](user-guide/installation.md) — prerequisites and the first run.
- [CLI Reference](user-guide/cli-reference.md) — every command, its flags and its output.
- [Example Walkthrough](user-guide/example-walkthrough.md) — the commands end to end against a sample API.
- [Run Report](user-guide/reports.md) — the `report.json` / `--json-output` shape for CI.
- [LLM Providers](user-guide/llm-providers.md) — model and credential configuration.

## Understanding the design

- [Architecture Overview](architecture/overview.md) — the pipeline stages and how they fit together.

## Working on Spec Forge

- [Contributing & Testing](developer-guide/contributing.md) — local setup and how to run each module's suite.
- [CLI Internals](developer-guide/cli-internals.md) — the orchestrator's layering and command registry.
- [Modules](modules/contract-engine/index.md) — a per-package implementation deep dive.
- [Test Corpora](testing/index.md) — the `tests-repos` corpora and the integration suite that runs Spec Forge against real APIs.
