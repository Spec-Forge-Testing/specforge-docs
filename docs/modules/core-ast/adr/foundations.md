# Core AST — Decision records — Foundations

Part of the [Core AST decision records](index.md). Package-wide decisions that
don't belong to a single pipeline stage: where constants live, which DTOs
validate at the boundary, and what an exception is allowed to say.

---

## ADR-004 — Constants live with the stage that uses them { #adr-004 }

**Status:** accepted · every stage · supersedes the single `cte/constants.py`

### Context

Every constant in the package lived in one 155-line `cte/constants.py`, and the
only namespace was a prefix in the name (`LOCATOR_`, `TRACER_`, `AST_BUILDER_`).

Measuring which stage actually imports which constant showed two things:

- **Of twenty constants, exactly one is used by more than one stage.**
  `EXTENSION_TO_LANGUAGE` is read by `ast_builder`, `locator`, `quality` and
  `tracer`. Every other constant had a single consumer.
- **The prefixes were lying.** Eight of the nine `TRACER_*` constants are
  consumed by `quality`, not by the tracer — thresholds, budget limits, the
  critical-keyword list. Only `TRACER_NON_TRACEABLE_CALLS_BY_LANGUAGE` belongs to
  the tracer. `models/tracer_result.py` appeared to be a second consumer of the
  thresholds, but only names them in a docstring; it does not import them.

A shared module that is 95% private to one consumer is not a shared module. It
just makes every stage's constants look like everyone's business, and lets a
prefix drift away from the code it names.

### Decision

One `constants.py` per stage, holding what only that stage uses.
`cte/constants.py` keeps what **two or more** stages share — today
`EXTENSION_TO_LANGUAGE` and the `words()` helper that builds the vocabularies,
and nothing else.

Names lose the stage prefix, because the module now provides it:
`TRACER_MAX_FILES` becomes `quality.constants.MAX_FILES`.

A data file moves with the constant that points at it: `patterns.toml` now lives
in `locator/`, its only reader, which also removes the `parent.parent` walk that
`PATTERNS_PATH` and `AST_BUILDER_TAGS_DIR` needed to climb out of `cte/`.

### Consequences

`cte/constants.py` went from 155 lines to 22. Each stage's table is small enough
to read whole, and a constant's blast radius is visible from where it is
declared.

Promoting a constant to `cte/` is now a deliberate step rather than the default.
That is the point: it forces the question of whether both stages really mean the
same thing by it.

The cost of dropping the prefixes is that two stages now declare
`EXCLUDE_DIR_PATTERNS` with **different contents** — the locator excludes build
output and dependencies, `quality` also excludes tests, migrations and generated
code. Same name, different meaning, which the old prefixes hid rather than
solved. No module imports both today; one that needs to will have to alias.

---

## ADR-044 — Pydantic on the boundaries, dataclasses inside { #adr-044 }

**Status:** accepted · `models/`

### Context

Ten DTOs carry data between stages. Pydantic validates, coerces and can emit a
JSON schema; a dataclass does none of that and costs nothing.

Using pydantic for all ten is the consistent choice. It also means every internal
accumulator pays validation on every mutation, for data that no external caller
ever sees.

### Decision

Pydantic for anything that crosses out of the package or between stages as a
result — `EndpointDefinition`, `LocatorResult`, `ExtractedContext`,
`TracerResult`, `LLMPayload`, `EndpointAnalysis`. A plain dataclass for what
stays inside: `DependencyContext`, the tracer's accumulator, and `ImportEntry`,
which passes between three stages but is built and read only by them.

`ASTContext` is pydantic with `arbitrary_types_allowed`, which buys almost no
validation — `tree` and `tag_query` are `Any` — and is there for uniformity with
the other stage outputs.

### Consequences

The line is "does anything outside this package construct or inspect it", and it
is a judgement, not a rule a reader can derive. `ImportEntry` is the awkward
case: it crosses three stages, so it looks like a boundary type, but it is
frozen, small, and built exclusively by the analyzers — validating it would only
catch a bug in code that lives next to it.

Mixing the two also means two idioms for the same job in one package. The
compensation is that a pydantic model in `models/` signals "someone outside
depends on this shape", which is exactly what you want to know before changing a
field.

---

## ADR-045 — An exception says what happened, not what to do about it { #adr-045 }

**Status:** accepted · `exceptions.py`

### Context

Three of the package's exceptions used to carry instructions in their message:

> `Extensión '.cob' no pertenece al Golden Path. El orquestador debe activar el
> mecanismo de fallback.`
>
> `Función 'x' no encontrada en 'y'. El orquestador debe enviar el archivo
> completo como fallback.`

They were written when a single orchestrator consumed the package and the
recovery was assumed to be one thing.

### Decision

The message states the fact. What to do about it belongs to the caller, and the
package already gives it what it needs to decide: a typed exception, its
attributes, and `ENDPOINT_ANALYSIS_ERRORS` saying which failures are per-endpoint
([ADR-043](api.md#adr-043)).

### Consequences

Two callers can now respond differently to the same exception without one of
them contradicting the text it prints. The CLI shows the message to a person;
`analyze_endpoints` records it per endpoint; neither is told to "activate the
fallback mechanism", a phrase that named nothing in the code by the time it was
removed.

The rule also applies to docstrings on the exception classes, which had drifted
into naming a single cause as the definition — `TargetNodeNotFoundError` was
documented as "(outdated Swagger)", one possible cause, when the common one today
is a handler the tag query does not capture.
