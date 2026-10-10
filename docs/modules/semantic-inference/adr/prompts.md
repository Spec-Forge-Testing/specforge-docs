# Semantic Inference — Decision records — Prompts

Part of the [Semantic Inference decision records](index.md). Decisions about
what the contract prompt tells the model besides the handler's code.

---

## ADR-093 — The prompt carries the declared security requirement and request-type constraints { #adr-093 }

**Status:** accepted · `prompts/templates/partials/security_requirement.j2`, `prompts/templates/partials/declared_constraints.j2`

### Context

Two parts of a contract are rarely visible in a handler. Who may call an
endpoint is usually enforced by a framework middleware that the source context
does not include, so a model reading the handler alone sees no check and calls
an authenticated endpoint public. The length, range and format limits of a
request body are usually declared on the type the handler binds the body into —
struct tags, Bean Validation, pydantic or serializer fields, validation rules —
so a model reading the handler alone invents limits or misses them. Both are
written down elsewhere: the OpenAPI document declares each operation's
security, and the static analysis can carry the bound type's declarations. A
wrong `access` policy makes the auth checks expect the wrong outcome; a wrong
`minLength` makes the fuzzer generate inputs the server rightly rejects, or
never reach the ones it wrongly accepts.

### Decision

What is declared is given to the model as evidence, never left to be guessed:

- the endpoint's resolved OpenAPI security travels in the OpenAPI definition and
  is stated in words under SECURITY REQUIREMENT — none, optional or required,
  with each scheme and where its credential travels. The `access` and `risk`
  rules treat it like code: an endpoint that requires authentication is at
  least `authenticated`, and its `auth_surface` is true;
- the declarations of the type the handler reads the body into arrive in a
  `<types>` block of the source context, and the DECLARED CONSTRAINTS rules
  translate each one into the kernel's schema keyword, on the field where the
  OpenAPI definition places it. The rules belong to the `qa` and `security`
  templates; the agent-neutral fallback stays rule-free.

### Rejected

Inferring both from the handler alone: the evidence is not in the handler, so a
better instruction cannot recover it. Validating the inferred contract against
the specification afterwards: a check can reject or overwrite a wrong answer
but cannot supply the missing evidence, the specification does not carry the
limits declared on the bound type, and a second rule set would duplicate what
contract fusion already decides.

### Consequences

The model starts from the same facts the specification and the types state,
and spends its inference on what only the code shows. The shared `system` block
is longer, so every call costs more input tokens; the estimate renders the same
prompt, so it includes them. Because fusion replaces a body object's `required`
list with the model's, the rules ask for the complete list, not only the fields
the type adds. A type whose code is omitted from the context yields no rules.
Any edit to either partial moves the prompt fingerprint and invalidates cached
contracts once.
