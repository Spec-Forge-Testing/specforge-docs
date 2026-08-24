# semantic_inference

Structured Inference Engine — the orchestrating brain between static analysis and
deterministic execution.

This module turns the pure context extracted from source code (AST) and OpenAPI
contracts into mathematical invariants, domain bounds, and hidden business rules.
Instead of relying on free-form conversational interaction, it implements a strict
inference pipeline backed by a multi-agent architecture, dynamically feeding the
Property-Based Testing engine.

## Environment configuration

The client needs to know which model to call and which credentials to authorize
with. See [User Guide → LLM Providers](../../user-guide/llm-providers.md) for the
full provider/variable table and setup instructions.

## About the tests

Two levels of validation are included:

- **Local/unit tests** — exercise configuration, template loading, and the client
  wrapper in isolation.
- **Integration smoke test** — makes real calls to the configured model's API (e.g.
  sends a "Ping" and expects a "Pong").

  Integration tests (marked `@pytest.mark.integration`) don't run in the GitHub
  Actions pipeline by default, so builds don't fail randomly from network issues,
  missing real credentials, or a provider's temporary outage.

Test commands are centralized in
[Contributing & Testing](../../developer-guide/contributing.md#exceptions).
