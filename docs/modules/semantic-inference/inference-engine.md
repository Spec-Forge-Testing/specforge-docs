# Semantic Inference — Inference engine

`SemanticInferenceEngine` (`ai.engine`) is the one entry point of the package:
it infers a contract, prices the prompts it would send, and identifies a prompt.
Part of [Semantic Inference](index.md); what the prompt contains is in
[Prompts](prompts.md).

## Building an engine

```python
SemanticInferenceEngine(*, llm_client=None, templates=None, settings=None)
```

| Argument | Default | Use |
| --- | --- | --- |
| `settings` | `llm.get_settings()` | The `llm.LLMSettings` the engine runs with: the model chain, the keys, the call budget. |
| `llm_client` | `llm.LLMClient(settings=settings)` | The client the contract calls go through. |
| `templates` | `TemplateRepository()` over the packaged templates | Another template directory, for tests or a custom prompt set. |

Loading the settings or building the client may fail with
`llm.LLMConfigurationError`; the constructor raises it as
`InferenceConfigurationError`, so a caller never catches an `llm` type.

`ai.config.inference_settings(overrides)` builds the settings with explicit
values — keyed by `LLMSettings` field name, such as `primary_model` — taking
precedence over the environment. That is how a caller applies a project's own
model configuration and passes it as `settings=`.

## `generate_contract`

```python
generate_contract(request: InferenceRequest, *, agent: str)
    -> tuple[EndpointContract, StructuredCompletionMetrics]
```

1. **Resolve the profile.** `resolve_agent_profile(agent)` validates the slug;
   an unknown one raises `UnknownAgentProfileError` before anything is
   rendered.
2. **Render.** The profile's template is resolved for the primary model and
   rendered with `contract_prompt_context(request, profile)` into a `system` and
   a `user` block.
3. **Complete.** Two messages go to `llm`'s `complete_structured` with
   `EndpointContract` as the response model: the `system` block marked
   `cacheable`, then the `user` block. The engine allows two output re-asks when
   an answer fails validation; transport retries and fallbacks are `llm`'s
   policy, described in [LLM › Failures and the policy](../llm/reference.md#failures-and-the-policy).
4. **Bind identity and sections.** The contract is copied with the request's
   `method` and `path_url`, whatever the model wrote there, and with every
   section the profile does not fill reset to the field's default. A withheld
   section the model emitted anyway is logged at `INFO`.
5. **Report.** The `StructuredCompletionMetrics` of the call — attempts,
   retries, tokens, cache tokens, parse errors and cost over every request —
   are logged at `INFO` on the `ai.engine` logger and returned with the
   contract. Their fields are described in
   [LLM › Usage metrics](../llm/reference.md#usage-metrics).

The contract that comes back is valid against the kernel's model. Whether it
fits the endpoint — fusion with the OpenAPI definition and projection for the
execution engine — is decided by the caller.

## `estimate_contracts`

```python
estimate_contracts(requests: Sequence[InferenceRequest], *, agent: str,
                   prompt_cache: bool = True) -> CostEstimate
```

Prices, in order, the prompts `generate_contract` would send for `requests`,
without sending any. Both methods render through the same step, so the estimate
covers exactly the `system` and `user` messages a run sends, under the same
profile and the same template. The messages go to
`llm.estimate_structured_calls` with `EndpointContract` as the response model
and the settings' primary model.

| Assumption | Value |
| --- | --- |
| Output per call | `EXPECTED_CONTRACT_OUTPUT_TOKENS`, 366 tokens, the mean output of a contract inference measured on a live run |
| Prompt cache | modelled when `prompt_cache` is true: the shared `system` block is written once and read by every later call, if the provider caches and the block is long enough |
| Model | the primary model only; fallback models are not estimated |
| Attempts | one per call; transport retries and output re-asks are not estimated |

The result is an `llm.CostEstimate`: per-call and total tokens, and a cost that
is `None` when the model has no known price. How tokens are counted and priced
is in [LLM › Estimating a batch](../llm/reference.md#estimating-a-batch).

## `prompt_fingerprint`

```python
prompt_fingerprint(agent: str) -> PromptFingerprint
```

Names what shapes the agent's prompt — the resolved template, a digest of the
template tree, of the vocabulary and of the response schema, the primary model
and the profile's sections — without rendering or calling anything. It is
computed once per profile and kept for the life of the engine. Each field and
what a cache keyed by it invalidates is in
[Prompts › The prompt fingerprint](prompts.md#the-prompt-fingerprint).

## Errors

Every exception the engine raises is a `SemanticInferenceError`, exported from
`ai.models`. Errors from `llm` are wrapped and chained, so the original is
reachable through `cause` and `__cause__`.

| Exception | Raised by | When | Attributes |
| --- | --- | --- | --- |
| `UnknownAgentProfileError` | all three methods | the agent slug is not a registered profile | `requested`, `known` |
| `PromptResolutionError` | all three methods | no template exists in the resolution chain | `agent`, `model`, `candidates` |
| `PromptStructureError` | `generate_contract`, `estimate_contracts` | the resolved template lacks its `system` or `user` block | `template`, `missing_blocks` |
| `InferenceConfigurationError` | the constructor, `generate_contract` | `llm` cannot be used as configured: a missing model or key, or a parameter the model refuses | `cause`, `missing` |
| `StructuredCompletionError` | `generate_contract` | the completion ended without a valid answer: every model of the chain failed, the call budget ran out, or a terminal failure such as a rejected key or request | `agent`, `template`, `cause`, `metrics` |
| `InferenceEstimationError` | `estimate_contracts` | the prompts could not be priced offline | `agent`, `model`, `cause` |

`InferenceConfigurationError` is a fault of the whole run, not of one endpoint:
no other endpoint or profile would succeed with the same settings. Its message is
the `llm` error's, and `missing` names the variables to set.

`StructuredCompletionError.metrics` is what the failed call paid for, every
model tried included; it is `None` when no model is reached. Its message
carries the `llm` error's, which names what happened to each model.

There is no separate contract-validation error: `llm` validates the answer
against `EndpointContract` and re-asks, and an answer that never validates ends
as a `StructuredCompletionError`.

A template that names a variable the context does not provide fails to render
with Jinja's own `UndefinedError`; that is a defect of the template, not of the
input.

## Configuration

The package reads no configuration of its own. The model chain, the keys, the
timeouts and the call budget are `llm` settings, read from the process
environment and the `llm` env file; see
[LLM › Configuration](../llm/index.md#configuration) and
[LLM › Settings and the model chain](../llm/reference.md#settings-and-the-model-chain).
To run with other settings, build them with `inference_settings(overrides)` or
`llm.get_settings(...)` and pass them as `settings=`.

`required_api_key_env_vars(model)` names the environment variables, any one of
which holds the key for `model`.

## Where to change what

| To | Change |
| --- | --- |
| Change the output size an estimate assumes | `EXPECTED_CONTRACT_OUTPUT_TOKENS` in `engine.py` |
| Change what a profile fills | `_PROFILE_SECTIONS` in `agents/profiles.py` |
| Change what the model is told | the templates and partials, see [Prompts](prompts.md) |
| Change retries, fallbacks or the model chain | `llm` settings, see [LLM](../llm/index.md) |
