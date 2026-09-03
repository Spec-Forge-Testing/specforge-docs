# Core AST — Decision records — AST builder

Part of the [Core AST decision records](index.md). AST-builder-stage decisions:
turning source into a tree-sitter tree — grammar loading, shared tag queries,
and the syntax gate that decides when a tree is too broken to use.

---

## ADR-018 — Five grammars ship with the package, seven are an optional extra { #adr-018 }

**Status:** accepted · `ast_builder/`

### Context

Twelve languages need twelve tree-sitter grammars. Making all twelve hard
dependencies means every install pays for every language; making all twelve
optional means a bare install cannot parse anything.

### Decision

Five grammars — Python, JavaScript, TypeScript, TSX, Go — are hard dependencies,
imported at module load and held in `LANGUAGE_FACTORIES`. The other seven are the
`[golden-path]` extra, listed by module name in `DYNAMIC_LANGUAGE_MODULES` and
imported on first use.

A grammar that is not installed raises `UnsupportedLanguageError`, the same
exception as an unsupported extension: from the caller's side, "this file is
outside the Golden Path" is one situation, not two.

The dynamic path looks for the grammar under two attribute names, `language` and
`language_<name>`. Nine packages expose `language`; `tree_sitter_php` exposes
`language_php`. A package following neither convention is treated as not
supported rather than probed with ever less likely names.

### Consequences

Two tables and two branches in `get_language` for what is one concept. They are
kept side by side in `ast_builder/constants.py` so the split is visible; putting
one in the code and the other in a table is how they drift.

The real cost lands on CI, which installs only the base dependencies: 22 tests
that need an optional grammar are skipped there and only ever run locally. Tests
that need one must carry `@pytest.mark.requires_grammar`, or they pass locally and
fail in CI — which is exactly what happened once.

---

## ADR-019 — Languages that share a grammar's shape share its tag query { #adr-019 }

**Status:** accepted · `ast_builder/constants.py`

### Context

Ten `.scm` files cover twelve languages. JavaScript, TypeScript and TSX had three
files that were the same file copied: adding a capture meant writing it three
times, and forgetting one left that language without it.

### Decision

`SHARED_TAG_QUERIES` maps a language to the query file it borrows. JavaScript and
TSX both use `typescript.scm`.

The grammars genuinely differ — JSX is not TypeScript — but the nodes that *name a
definition* are the same three shapes, and those are the only thing the query
captures.

### Consequences

This is the same idea as [ADR-006](locator.md#adr-006) —`.tsx` inheriting `.ts`'s
rules in `patterns.toml`— arrived at independently in another stage, keyed by
language instead of by extension. Two tables express one thought, and a language
added to one is not added to the other.

The condition for sharing is narrower here than it looks: not "similar languages"
but "the same node types name a definition". A grammar that names definitions
differently needs its own file even if the language is a close relative.

---

## ADR-020 — The syntax gate only rejects an unusable tree { #adr-020 }

**Status:** accepted · `ast_builder/manager.py`

### Context

tree-sitter is error tolerant: it returns a tree for input it could not fully
parse. `build_context` has to decide what is too broken to use.

### Decision

Reject only when the root node *is* an `ERROR`, or when it has no children and
carries an error. Anything else is handed on, errors and all: a broken function
elsewhere in the file should not cost the handler.

### Consequences

Measured, on a file with one unparseable function and one good handler:

| Where the damage is | Result |
| --- | --- |
| Garbage before the handler | handler extracted |
| Broken function *after* the handler | handler extracted |
| Broken function *before* the handler | **handler lost** |

The third row is not caught by this gate and is not meant to be. tree-sitter's
recovery swallows the following definition into the broken one's `ERROR` node, so
the tag query never sees it and the failure surfaces one stage later, as
`TargetNodeNotFoundError` from the extractor.

So the gate does what it claims — it does not reject a usable tree — but "usable"
is not the same as "everything in it is reachable". Any future work on partial
syntax tolerance belongs in the query, not here.

---

## ADR-021 — An `operationId` only names the handler if it names something callable { #adr-021 }

**Status:** accepted · `api.py` · `extractor/function.py`

### Context

`_resolve_target` takes a shortcut: if the contract's `operationId` matches a
definition in the located file, use it as the handler name and skip inference.

It checked against *every* definition, types included. That held only because the
tag queries were incomplete — several languages did not capture types at all. The
moment they did, RealWorld's `operationId: CreateArticle` started matching axum's
`struct CreateArticle`, the request body, and the pipeline returned a struct as
the handler for `POST /articles`.

### Decision

The shortcut requires a **callable**: `collect_callable_names` keeps only names
captured under `definition.function` or `definition.method`.
`collect_definition_names` still returns everything and is what the tracer uses,
where a type is a legitimate local definition — a constructor call is a real
dependency.

### Consequences

A contract whose `operationId` genuinely names a class handler — a Django
class-based view, say — no longer takes the shortcut and falls through to
inference, which has to find it through the route declaration instead. No
endpoint in the corpus does this; all 228 produce byte-identical extractions
before and after.

The wider lesson is about the failure mode, not the rule: this bug was invisible
while a second component was also wrong. Completing the tag queries is what
exposed it. Two defects that cancel out read as correct until one is fixed.

---

## ADR-022 — The tag queries and `[class_keywords]` are checked against each other { #adr-022 }

**Status:** accepted · `ast_builder/tags/` · `tests/test_ast_builder/test_tag_queries.py`

### Context

`patterns.toml [class_keywords]` says what a type declaration looks like **in
text**; the `.scm` files say what one looks like **in the tree**. Nothing kept
them in agreement, and seven of eleven extensions had drifted: TypeScript and
JavaScript captured no class at all, Go captured no `type`, Rust no `struct`,
`enum` or `trait`, and Java, C# and PHP missed most of theirs.

`c_sharp.scm` also captured `(identifier) @name` without the `name:` field, so
the first identifier child of a method declaration — the **return type** — was
recorded as the method's name. `extract_function("ArticleResponse")` returned the
body of `GetArticle`.

### Decision

Every keyword in `[class_keywords]` must be captured by that language's query,
enforced by a parametrised test that parses one sample per keyword. Deliberate
exceptions live in a table with their reason, and the test fails if an exception
starts being captured — so the list can only shrink by accident, never grow.

Two exceptions exist today, both TypeScript's `interface` and `abstract class`,
for the reason in the next section.

### Consequences

**A shared query can only name node types that exist in every grammar sharing
it.** JavaScript's grammar has no `type_identifier` and no
`interface_declaration`, and a query naming either fails to *compile* for
JavaScript — not silently, but the file becomes unloadable. That is why the class
name is captured with the wildcard `(_)` and why TypeScript's interfaces are not
captured at all: neither an interface nor an abstract class can be a handler or
be called, so capturing them would not repay splitting the file and reviving the
duplication [ADR-019](#adr-019) removed.

The suite grew by 58 cases and now compiles all twelve queries against their real
grammars, which is the check that would have caught the C# defect the day it was
written.

Lo mismo con `protocol_function_declaration` en Swift: sin él la cadena se
cortaba antes del protocolo, aunque las interfaces de Java ya entraban.
