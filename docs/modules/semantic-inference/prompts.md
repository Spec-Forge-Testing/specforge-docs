# Semantic Inference — Prompts

How a contract prompt is found, what it tells the model, which values it renders
with, and how a prompt is identified so a cached answer can be trusted. Part of
[Semantic Inference](index.md).

## Package layout

```text
src/ai/
├── agents/profiles.py     AgentProfile, ContractSection, sections_for
├── config.py              inference_settings, required_api_key_env_vars
├── models/                InferenceRequest, StateHints, RenderedPrompt, PromptFingerprint, errors
├── prompts/
│   ├── loader.py          TemplateRepository: resolution and rendering
│   ├── context.py         contract_prompt_context: the variables of every contract template
│   ├── vocabulary.py      CONTRACT_VOCABULARY: closed value sets read off the kernel
│   ├── fingerprint.py     the three digests of a prompt fingerprint
│   └── templates/
│       ├── default.j2, qa_default.j2, security_default.j2
│       └── partials/      the blocks the contract templates share
└── engine.py              SemanticInferenceEngine
```

## The template repository

`TemplateRepository` loads Jinja templates from `prompts/templates/`. Rendering
is strict: a variable the context does not provide fails the render instead of
printing as an empty string, and nothing is HTML-escaped. JSON written by the
`tojson` filter has its keys sorted and keeps non-ASCII text verbatim.

### Resolution chain

`resolve_agent_template(agent, model)` returns the first template that exists:

1. `{agent}_{model_slug}.j2`, where `model_slug` is the model name with `/`
   replaced by `_` — a template written for one model;
2. `{agent}_default.j2` — the profile's template;
3. `default.j2` — the agent-neutral fallback.

The model is the settings' primary model. When no candidate exists,
`PromptResolutionError` names every candidate tried. Since `default.j2` ships
with the package, the chain always ends somewhere; that is why the profile is
validated first, so an unknown slug fails with `UnknownAgentProfileError`
instead of resolving silently to the fallback.

### The two blocks

Every contract template declares a `system` block and a `user` block.
`render_prompt(template_name, **context)` renders each on its own into a
`RenderedPrompt(system, user)`; a template missing either block raises
`PromptStructureError` with the `missing_blocks`.

| Block | Contents | Varies with |
| --- | --- | --- |
| `system` | the persona, the guidelines, the declared-constraints rules, the output contract | the profile only |
| `user` | the endpoint identity, its security requirement, the context warning, the source context, the state link | the endpoint |

The engine sends the `system` block as a cacheable message and the `user` block
after it. Because the `system` block is identical for every endpoint under one
profile, a provider with a prompt cache reads it from the cache after the first
call; see [LLM › Prompt caching](../llm/reference.md#prompt-caching).

## The contract templates

| Template | Persona and guidelines | Declared constraints |
| --- | --- | --- |
| `qa_default.j2` | A QA automation engineer: numeric and date bounds, patterns, sizes and cardinalities, which fields are required. | yes |
| `security_default.j2` | An application security engineer: the safe shape of injection-prone fields, the real shape of authorization identifiers, legitimate numeric ranges, no attack described in prose. | yes |
| `default.j2` | A neutral structured inference engine. | no |

Both profile templates end their guidelines with the same rule: do not invent
fields the code does not justify.

## The partials

Each partial under `templates/partials/` is one part of what the model is told.

| Partial | Block | What the model is told |
| --- | --- | --- |
| `endpoint_identity.j2` | user | The method and path of the endpoint, under ENDPOINT IDENTITY. |
| `security_requirement.j2` | user | The OpenAPI security requirement in words, under SECURITY REQUIREMENT (below). |
| `context_warning.j2` | user | Only when `is_partial_context` is true: the source context is partial, unseen code must not be assumed absent, and omitting an unknowable constraint is safer than inventing one. |
| `source_context.j2` | user | The source context under SOURCE CODE CONTEXT, then the OpenAPI definition as indented JSON under OPENAPI BASE DEFINITION. |
| `state_link.j2` | user | The bundles the endpoint produces and consumes, under STATE LINK (below). |
| `declared_constraints.j2` | system | How validation declared on the request type becomes body constraints (below). `qa` and `security` only. |
| `output_contract.j2` | system | The allowed top-level keys, then the schema vocabulary, one section partial per section of the profile, and the output rules. |
| `schema_vocabulary.j2` | system | The only keys a schema fragment may use, which type each keyword belongs to, and that a range is never empty. |
| `section_<name>.j2` | system | One per `ContractSection`: the section's fields, its closed values and the rules a contract is rejected for. |
| `output_rules.j2` | system | The wire dialect (JSON Schema keywords in camelCase, everything else in snake_case), omit a section rather than send it empty, never emit a key not described, a single JSON object without fences or prose. |

### The security requirement

The endpoint's OpenAPI definition carries its resolved `security`, as
[Contract Assembly](../contract-assembly/index.md) dumps it: a `requirement`
level (`none`, `optional` or `required`) and the alternatives a caller may
satisfy, each a list of schemes. The partial states it in one of four ways:

| The document says | The model reads |
| --- | --- |
| no `security` for the endpoint | the document does not declare a security requirement |
| `requirement` is `none`, or no alternative names a scheme | the endpoint requires no authentication |
| `requirement` is `optional` | it requires authentication only optionally, with one of the listed alternatives |
| `requirement` is `required` | it requires authentication, with one of the listed alternatives |

Each scheme is described by name, kind, where an API key travels, the HTTP
scheme and bearer format, and its scopes; schemes of one alternative are joined
with "and". The `access` and `risk` sections take this requirement as evidence
next to the code: an endpoint that requires authentication is at least
`authenticated` even when the handler does not show the check, and
`auth_surface` is true for it.

### The declared constraints

Much of a body's validation is declared on the type the handler binds the
request into, not written in the handler. The static analysis carries those
declarations in a `<types>` block of the source context, and this partial tells
the model to read them as code:

- only the type the handler reads the request body into counts;
- each constraint goes on the field where the OpenAPI definition places it,
  inside a wrapping object when there is one;
- each declared rule maps to a kernel keyword: `required`, `minLength` (also for
  a rule that rejects an empty string), `maxLength`, `minimum`, `maximum` (an
  exclusive integer bound moved one step inside), `minItems`, `maxItems`,
  `format` and `pattern`;
- an optional marker never makes a field required, and an update that starts
  from the stored record has no required field on the wire;
- a `required` list replaces the OpenAPI's list for that object, so it names
  every field the code requires there.

The partial lists the spellings of each rule across the supported frameworks.
`default.j2` does not include it.

### The state link

`state_link.j2` lists each produced bundle with the response field it is
captured from, and each consumed bundle with the zone and field it is injected
into. An endpoint that produces nothing is told to omit `transitions`; one that
consumes nothing is told never to use `owner_only`. The `transitions` and
`access` sections point the model at these names, which it must spell exactly.

## The prompt context

`contract_prompt_context(request, profile)` builds the variables every contract
template renders with.

| Variable | Value |
| --- | --- |
| `method`, `path_url` | the request's identity |
| `system_context` | the source context |
| `is_partial_context` | whether the context is partial |
| `openapi_endpoint` | the OpenAPI definition, `security` included |
| `state_hints` | the request's `StateHints`, or an empty one |
| `sections` | `prompt_sections(profile)`: the profile's section names, in the order `ContractSection` declares them |
| `vocab` | `CONTRACT_VOCABULARY` |

## The vocabulary

Every closed set of values the prompts name is read off the kernel when the
module loads, into `CONTRACT_VOCABULARY`. The prompt can therefore never offer a
value the kernel rejects, nor miss one it adds.

| `ContractVocabulary` field | Read from |
| --- | --- |
| `schema_keywords` | `SchemaProperty`'s fields, by their JSON Schema alias where there is one |
| `attack_profiles`, `criticalities`, `sensitivities`, `zones`, `access_policies`, `property_classes` | the members of `AttackProfile`, `Criticality`, `Sensitivity`, `Zone`, `AccessPolicy`, `PropertyClass` |
| `expression_kinds` | the `kind` discriminator of each `PropertyExpression` node |
| `binary_operators`, `aggregation_functions`, `logical_operators` | the literals of `BinaryOperator`, `AggregationFunction`, `LogicalOperator` |
| `risk_score` | the `ge`/`le` bounds of `EndpointRisk.risk_score` |
| `aggressiveness`, `mutation_depth` | the `ge`/`le` bounds of `EndpointAttack`'s fields |

The bounds are `IntegerBounds(minimum, maximum)`. The kernel's models are
described in [Contracts](../contracts/index.md).

## The prompt fingerprint

`SemanticInferenceEngine.prompt_fingerprint(agent)` names what shapes an agent's
prompt, short of the endpoint it is asked about. It renders nothing and calls
nothing, and it is computed once per profile for the life of the engine.

| `PromptFingerprint` field | What it captures |
| --- | --- |
| `template` | the template the agent resolves to |
| `template_tree_sha256` | every `.j2` file under the template directory |
| `vocabulary_sha256` | `CONTRACT_VOCABULARY` |
| `response_schema_sha256` | the JSON Schema of `EndpointContract` |
| `primary_model` | the model the prompt is resolved and priced for |
| `sections` | the profile's section names |

The template digest hashes each file under its relative path, with line endings
normalized and every chunk length-prefixed, so it does not depend on the
checkout. The vocabulary and the schema are hashed as canonical JSON.

A cache keyed by the fingerprint, together with the endpoint's own input,
invalidates every cached contract at once when any template or partial is
edited, a kernel vocabulary value is added or removed, a field of the response
schema changes, the primary model changes, or the profile's sections change. A
change to how the templates are rendered that edits no template does not move
it, so such a change goes with a template edit.

## Adding a profile

1. Add the member to `AgentProfile` in `agents/profiles.py`:
   `ANALYTICS = "analytics"`.
2. Give it its sections in `_PROFILE_SECTIONS` in the same file; `sections_for`
   has no default for a profile that is missing there.
3. Write `templates/analytics_default.j2` with a `system` and a `user` block,
   including the shared partials. Without it the profile resolves to
   `default.j2`, which has no declared-constraints rules.
4. Map a fuzz mode to the new slug in the caller; the engine accepts any
   registered slug as `agent=`.

## Adding a model-specific template

Write `templates/<agent>_<model_slug>.j2`, for example
`qa_provider_model-name.j2` for the model `provider/model-name`. It wins over
`qa_default.j2` whenever that model is the primary one, and must declare the same
two blocks.

## Adding a partial

1. Write `templates/partials/<name>.j2`.
2. Include it in the block it belongs to: `system` when it is the same for every
   endpoint, `user` when it depends on the endpoint. Endpoint data in the
   `system` block would break the shared cacheable prefix.
3. A new variable goes into `contract_prompt_context`; until it is there, the
   strict render fails.

The fingerprint moves on its own, so cached contracts are invalidated.

## Adding a contract section

1. The field exists on the kernel's `EndpointContract` first.
2. Add a `ContractSection` member whose value is that field's name, at the
   position the prompt should teach it in.
3. Write `templates/partials/section_<value>.j2`; `output_contract.j2` includes
   it by that name for every profile that lists the section.
4. Add the section to the profiles that fill it. A profile that does not get it
   has it reset to the field's default in every contract.

## Adding a vocabulary set

Add a field to `ContractVocabulary` and read it off the kernel in
`build_contract_vocabulary`; the templates reach it as `vocab.<field>`.
