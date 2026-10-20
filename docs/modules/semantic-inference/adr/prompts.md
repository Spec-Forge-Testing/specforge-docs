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

---

## ADR-136 — The model is asked for plausible examples and defaults per field, never identifiers { #adr-136 }

**Status:** accepted · `prompts/templates/partials/plausible_values.j2`, `prompts/templates/partials/schema_vocabulary.j2`, `prompts/templates/qa_default.j2`, `prompts/templates/security_default.j2`

### Context

A fuzzer reaches a handler's real logic faster when it starts from a value the
code accepts: a sort order the handler switches on, a currency code it parses, a
page size it falls back to. The engine already seeds its valid phase with a
field's `default` and `examples` ([ADR-121](../../specforge-engine/adr/compiler.md#adr-121)),
and contract fusion accepts both keywords on any type, but the model was never
asked for them. Those values are often visible only in the code.

### Decision

The `plausible_values.j2` partial, included in the `qa` and `security` templates
next to the declared constraints, asks for values only when the source context
makes a concrete one plausible:

- a value the code compares with or branches on, a shape the handler parses, a
  value in a fixture or seed file, or an example in a comment becomes `examples`,
  one to three of them;
- the value the handler applies when the field is absent becomes `default`; a
  typical value is not a default;
- every value satisfies the field's other constraints, and sits on the field
  where the OpenAPI definition places it.

**Never an identifier.** No value for an id, a foreign key, a slug, a token or
anything else that exists only once the database stores it. The schema vocabulary
lists `examples` and `default` among the keywords of any type.

### Rejected

Asking for a value on every field: the model would invent plausible-looking ids,
and an invented id only earns a 404 and teaches the fuzzer nothing. Leaving seeds
to the OpenAPI document alone: most documents declare few examples, and the code
is where the accepted values are written.

### Consequences

A field with evidence in the code reaches the valid phase with a value the handler
accepts; a field without evidence gets none. The agent-neutral fallback stays
free of the rule. The edit moves the prompt fingerprint and invalidates cached
contracts once.
