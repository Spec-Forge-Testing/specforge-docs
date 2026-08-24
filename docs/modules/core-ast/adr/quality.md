# Core AST — Decision records — Quality

Part of the [Core AST decision records](index.md). Quality-stage decisions: how
the tracer's completeness signal becomes a policy decision (surgical / hybrid /
fallback), and how the fallback bundle is assembled.

---

## ADR-037 — A critical unresolved call forces fallback, whatever the ratio { #adr-037 }

**Status:** accepted · `quality/policy.py`

### Context

The mode is chosen from `completion_ratio`. A handler with nineteen resolved
calls and one lost sits comfortably above the surgical threshold — regardless of
which one was lost.

But losing the function that formats a date and losing the function that verifies
a token are not the same loss. The second means the LLM infers the endpoint's
behaviour without seeing its authorisation, and invents an invariant that does
not hold.

### Decision

If any unresolved call's name contains one of `CRITICAL_KEYWORDS` — `auth`,
`verify_token`, `payment`, `charge`, `fraud`, `refund`, … — the mode is
`fallback` and the reason is recorded in `forced_abort_reason`, whatever the
ratio says.

Fallback means the whole file bundle instead of the surgical chain: less precise,
but the missing function is probably in there.

### Consequences

Matching is by **substring**, so `validate` also fires on `validate_email` and
`charge` on `recharge_cache`. That is the intended bias: a false alarm costs a
larger bundle, a miss costs a false invariant on the one endpoint where being
wrong matters most.

The list is a keyword table in Spanish-and-English-agnostic form, so a codebase
naming its authorisation `comprobarPermiso` gets no protection from it.

---

## ADR-038 — No expected calls means a ratio of 1.0 { #adr-038 }

**Status:** accepted · `quality/policy.py`

### Context

`completion_ratio` is `resolved / expected`. A handler that calls nothing has
`expected = 0`.

### Decision

The ratio is 1.0, not 0.0 and not an error. Having lost nothing is complete
context, not a division by zero.

### Consequences

It is also the shape of a silent failure, and it has bitten once. When six of the
twelve languages detected zero calls ([ADR-025](tracer.md#adr-025)), every endpoint
in them reported `expected_calls=0`, `completion_ratio=1.0` and mode `surgical` —
a perfect-completeness report over a payload that was only the controller.

Nothing in the result distinguishes *a handler that genuinely calls nothing* from
*a detector that found nothing*. `expected_calls=0` on a whole language is the
signal to watch, and it lives in the result for that reason.

---

## ADR-039 — The fallback bundle has a hard budget and a fixed priority { #adr-039 }

**Status:** accepted · `quality/fallback_planner.py`

### Context

The hybrid and fallback modes hand the LLM whole files instead of a surgical
chain. Without a limit, "whole files" on a real repository is an unusable prompt.

### Decision

A hard budget — 10 files, 2 000 lines total, 500 counted per file — filled in a
fixed priority order:

1. The controller, always, before any check.
2. The directly imported local files, exactly as `ImportScan` resolved them.
3. Files that merely mention an unresolved call.

`max_lines_per_file` caps what a file *counts* toward the total, not what is
included: the bundle never hands over code cut in half.

### Consequences

The order is what makes the truncation survivable: what falls off the end is
always the weakest evidence, files matched by a name appearing somewhere in them.
The controller cannot be dropped because it is added before the budget applies —
so a controller alone can exceed the line budget, and that is deliberate.

`truncation_applied` travels on the result, so a caller can tell a complete
bundle from one that ran out of room.
