# Contract Assembly

Contract Assembly turns an OpenAPI description into the normalized endpoint contract
used by the rest of Spec Forge. It is the boundary between external specifications
and the internal shared model.

## Responsibilities

1. Parse the source contract with `parse_contract`.
2. Adapt the parser output through `ASTAdapter`.
3. Fuse endpoint information into the canonical representation with `fuse_contract`.

## How it fits into the pipeline

Contract Assembly is the ingestion and fusion boundary. It receives an external
OpenAPI description, produces the normalized endpoint definitions, and combines
them with semantic contracts before the orchestrator sends them to the
execution engine.

## Use it when

- validating or inspecting an OpenAPI file from the CLI;
- obtaining endpoint paths, methods, parameters and bodies in a uniform shape; or
- preparing the input consumed by tracing, semantic inference and fuzzing.

See the [reference](reference.md) for the transformation stages, module layout,
CLI usage and development workflow.

## Read next

| If you want to | Read |
|---|---|
| Follow the parsing and fusion stages | [Reference](reference.md) |
| Understand the shared endpoint contract | [Contracts](../contracts/index.md) |
| Run or extend the module tests | [Contributing & Testing](../../developer-guide/contributing.md#test-a-compose-module) |
