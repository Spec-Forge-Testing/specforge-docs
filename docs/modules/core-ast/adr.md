# Core AST — Decision records

Decisions taken while building `core_ast` that are not obvious from reading the
code, and that someone would otherwise be tempted to undo. Each record states the
situation that forced the decision, what was decided, and what it costs.

They are append-only and numbered in the order they were written down. A record
is never edited to reflect a later change of mind — a new record supersedes it.

!!! info "The rule these decisions answer to"
    **Being wrong is worse than not finding.** If the pipeline hands back the
    wrong handler, the LLM infers another endpoint's business rules, and those
    false invariants become false findings against the endpoint under test. A
    miss costs five minutes; a confident wrong answer poisons everything
    downstream. When in doubt, raise.

---

## ADR-001 — Build output and dependency directories are excluded from the scan

**Status:** accepted · `locator/scanner.py`

### Context

`scan_repository` walks the whole repository and hands the locator a list of
candidate files. A project that commits its build output — the NestJS
implementation of the RealWorld corpus publishes its `dist/` — has **two copies
of every controller**: the source and the compiled artefact. Both contain the
route declaration, so the locator matched the endpoint twice, reported an
ambiguity and returned nothing. The endpoint was untestable because the project
was well organised.

### Decision

Paths under any directory named in `LOCATOR_EXCLUDE_DIR_PATTERNS` are dropped
during the scan: `node_modules`, `vendor`, `dist`, `build`, `out`, `target`,
`bin`, `obj`, `.git`, `.venv`, `venv`, `__pycache__`, `.next`, `.nuxt`,
`coverage`.

The tracer already excluded a similar set through `TRACER_EXCLUDE_DIR_PATTERNS`;
this puts the locator in agreement with it rather than leaving each stage with
its own idea of what counts as source.

### Consequences

A project whose only source genuinely lives under one of those names is
invisible to the locator, and the endpoint fails with `ControllerNotFoundError`.
That is accepted: the alternative is an ambiguity that returns nothing anyway, or
worse, silently picking the compiled copy — which is the wrong answer the
governing rule exists to prevent.

---

## ADR-002 — The repository scan is cached per repository, and what is cached is immutable

**Status:** accepted · `locator/scanner.py` · closes [AI-132](https://linear.app/ai-pbt/issue/AI-132)

### Context

`locate_controller` scans the repository once per endpoint, so analysing a
contract walked the same tree once per route. Measured against EMB's
`familie-ba-sak` (Kotlin/Spring, 7 410 files): 0.24 s per walk, and 5.1 s to
locate eight endpoints.

### Decision

`scan_repository` became a thin wrapper over `_scan_cached`, an `lru_cache`d
function keyed by `repo_root` and bounded by `LOCATOR_SCAN_CACHE_SIZE` (16).

Two details are deliberate:

- **`_scan_cached` returns a tuple, and `scan_repository` copies it into a
  list.** Handing callers the cached container would let any one of them mutate
  it and corrupt the result for everyone after. The public signature still
  returns `list[Path]`; the copy is what makes that safe.
- **The bound is 16, not a handful.** A normal run analyses one repository, but
  the corpus suite walks the twelve RealWorld implementations in a single
  process; with a smaller cache they would evict each other and the cache would
  do nothing exactly where it is exercised most.

### Consequences

Eight endpoints over `familie-ba-sak` went from 5.1 s to **3.4 s** — one walk
instead of eight. The corpus suite went from 47 s to 42.6 s.

Two known deviations from the ticket that asked for this:

- It asked for the index to live *in the orchestrator or the session, not as
  hidden global state*. What exists is module-level state. Honouring the request
  would change `locate_controller`'s signature and reach into `core/`, outside
  this package's boundary.
- The ticket's stated problem is O(N·M) in **both** the tree walk and the regex
  pass over candidate files. Only the walk is cached; every endpoint still reads
  and matches all candidates, which is the larger half of the cost.

---

## ADR-003 — The scan cache is invalidated explicitly, never automatically

**Status:** accepted · `locator/scanner.py`

### Context

An `lru_cache` lives as long as the process. A one-shot CLI invocation never
notices, but the REPL is long-running: run `trace`, edit a source file, run
`trace` again in the same session, and the second run would still see the file
list from the first.

Detecting that the repository changed would mean walking the tree to compare it —
which is precisely the cost the cache exists to avoid.

### Decision

`clear_scan_cache()` is public, and freshness belongs to the caller. A
long-running host calls it between runs; a one-shot process never has to.

### Consequences

The package cannot guarantee on its own that its answer reflects the current
state of disk — it guarantees that it reflects the state at the first scan of
this process. Any host that keeps a session open across edits is responsible for
saying when to forget.

---

## ADR-004 — Constants live with the stage that uses them

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

## ADR-005 — The route vocabulary is deliberately narrow

**Status:** accepted · `locator/constants.py`

### Context

A contract path (`/articles/{slug}`) is turned into a regex that has to match
however a framework wrote it. Two pieces of that translation look over-specified
and invite simplification.

### Decision

**Where a route ends** (`BOUNDARY`) accepts a quote, a comma, whitespace, end of
input — or `?$`, because Django writes routes as regexes (`r'^tags/?$'`), not as
literals. The trailing slash is optional: `"/tags/"` and `"/tags"` are the same
route.

A closing parenthesis and a closing bracket are **excluded on purpose**. Admit
either and a parameter's wildcard eats part of Django's own regex —
`(?P<slug>[-\w` followed by `]` — so `/articles/{slug}` matches
`^articles/(?P<slug>[-\w]+)/favorite/?$`, which is a different route.

**What stands in for a parameter** (`ANY_SEGMENT`) is not "any segment": it must
*look* like a parameter. All twelve frameworks mark them with one of `{`, `:`,
`<` or `*`, and requiring one is what stops `/articles/{slug}` from matching
`articles/feed`.

### Consequences

Both regexes are harder to read than the obvious version, and both will look
wrong to someone tidying them up. A framework that delimits routes some other way
needs a deliberate widening here, with a test for the route it must *not* match.

---

## ADR-006 — An extension inherits another's rules only within the same language

**Status:** accepted · `locator/constants.py`

### Context

`.tsx` had byte-identical entries to `.ts` in five tables of `patterns.toml`:
same NestJS, same Express, same keywords. Editing one and forgetting the other
left that extension on the old rule.

`.kt` and `.java` also share their entries today, because the Spring annotations
are the same.

### Decision

`EXTENSION_ALIASES` maps an extension to the one it inherits from, expanded into
every table when `patterns.toml` is loaded. It contains `.tsx → .ts` and nothing
else. **Kotlin is deliberately left duplicated.**

An alias is only for extensions of the *same* language. `.tsx` is TypeScript with
JSX. Kotlin merely agrees with Java today.

### Consequences

The inherited entry is *replaced* by an own entry, not merged with it. So the day
someone adds a Ktor pattern to `.kt`, that entry wins and Kotlin silently loses
every Spring pattern — which is exactly why the duplication stays.

---

## ADR-007 — A wildcard-only route form can name a handler, never choose a file

**Status:** accepted · `locator/patterns.py`

### Context

A contract path made only of parameters expands to a form with no literal
segment. `@Delete(':slug')` is a legitimate declaration, and its regex is
effectively `[^/]+`.

### Decision

Every form carries whether it has a literal segment (`PathForm.literal`, computed
by `_has_literal`). The locator keeps only forms with a literal; the handler
resolver takes them all, via `route_patterns(..., solo_literales=False)`.

### Consequences

The same expression is trusted in one stage and refused in the other, which reads
like an inconsistency until you see why: inside a file already chosen,
`[^/]+` distinguishes `@Delete("{slug}")` from `@Delete("{slug}/comments/{id}")`;
across a repository it matches every one-segment route there is, so it would
point at every file at once.

---

## ADR-008 — Every pattern is scoped to one language

**Status:** accepted · `locator/patterns.py` · `locator/scanner.py`

### Context

Searching a repository for a definition needs a regex, and the shape of a
definition differs per language. The cheap approach is to build one regex with
every language's alternatives and run it over every file.

Java and C# have no keyword before a method name, so their entry in
`[function_keywords]` is empty and they fall back to the universal heuristic
`\bNAME\s*\(` — which also matches a **call site**, not just a definition.

### Decision

Files are grouped by extension and each group is searched with the pattern its
own language produces (`search_by_extension`). No pattern ever merges the twelve.

### Consequences

Searching costs one pass per extension present instead of one pass total. In
exchange, a Python file that merely *calls* `createArticle()` no longer passes for
the controller that defines it — which is what the merged pattern did, in every
language, as soon as Java or C# was among the candidates.

---

## ADR-009 — Route templates are tried one at a time, never merged

**Status:** accepted · `locator/matcher.py`

### Context

A language usually has several route templates in `patterns.toml` — one
framework writes `@app.get("/x")`, another `router.GET("/x", h)`. Merging them
into a single alternation is one regex instead of *n*.

### Decision

`_build_nth_route_pattern` returns the template at `index` and nothing else. The
cascade walks the templates in order, deepest language first, and each index is
a separate strategy.

### Consequences

More passes over the candidate files. In exchange, two files that match for
*different reasons* never tie: with a merged regex they are indistinguishable
and the result is an ambiguity, whereas trying the templates in their declared
order — most specific first — resolves it. The order inside each language's list
in `patterns.toml` is therefore load-bearing, not cosmetic.

---

## ADR-010 — Following a router mount is two hops, and returns a scope

**Status:** accepted · `locator/matcher.py` · closes [AI-213](https://linear.app/ai-pbt/issue/AI-213)

### Context

When the prefix is declared in one file and the relative routes in another,
**there is no literal route to search for where the handler lives**. Gin writes
`router.GET("", ArticleList)`; FastAPI writes `@router.get("")`. The only thing
written down is the mount, where the prefix sits next to the symbol it applies
to:

```
articles.TagsAnonymousRegister(v1.Group("/tags"))   # Gin
router.include_router(tags.router, prefix="/tags")  # FastAPI
```

Mounting a router with a prefix is the norm in every framework the package
supports, not an exception.

### Decision

Search for the literal prefix, take the identifiers on that line, and see which
of them names or defines a file in the repository.

Two details:

- **It returns a scope, not just a file.** When the mounted symbol is a
  function, the scope is that function's body. One `routers.go` in Gin holds
  three `register` functions and each declares its own `GET("")`; without
  narrowing to the body, the handler named would be another resource's.
- **A named argument's name is never the mounted symbol.** FastAPI writes
  `include_router(articles.router, tags=["articles"])`, and `tags` is also the
  name of another route module — so the mount of `/articles` also pointed at
  `tags.py`, which has its own `@router.get("")`, and the two tied.

The strategy sits below every form written in the file itself (confidence 0.45):
it is two inferences deep, not one.

### Consequences

Only a **literal** prefix can be followed. `prefix=settings.API_PREFIX`,
`prefix=f"/{version}/tags"`, a mount inside an `if`, or a loop over discovered
modules are all out of reach by definition — the package does not execute code.
Those endpoints fail with `ControllerNotFoundError`, which is the intended
degradation.

---

## ADR-011 — Routes generated by a resource registration are located by convention

**Status:** accepted · `locator/matcher.py`

### Context

`Route::resource('articles', 'ArticleController')` serves five routes and writes
none of them; `resources :articles` in Rails, seven. There is no declaration to
find and no handler name to read.

### Decision

The last resort of the cascade. What is written is the resource, so the HTTP
method plus the shape of the path — collection or member — determine the action
by convention, from tables in `patterns.toml`. The strategy returns the handler
name along with the file, because nothing in the code states it.

A singular resource has no collection: `resource :user` serves `GET /user` with
`show`, not `index`, which is why the action tables come in two flavours.

### Consequences

It sits at the bottom of the cascade with confidence 0.35 — the lowest — because
neither the route nor the handler is written anywhere: both come from a
convention the project may not follow. The result is still checked against the
code (`defines`) before being returned, so a convention that does not hold
produces no answer rather than a wrong one.

---

## ADR-012 — An ambiguous strategy does not abort the cascade

**Status:** accepted · `locator/matcher.py`

### Context

`locate_controller` tries strategies from most to least specific. When one
matches several files, the obvious move is to stop and report the ambiguity.

### Decision

An ambiguous strategy is **remembered, not raised**, and the cascade continues —
a later, less specific strategy may still resolve to a single file. If none does,
what gets raised is the **most specific** ambiguity encountered, because it is the
one that says the most about the repository.

Only one strategy narrows before giving up: `class_prefix`, which several
controllers can share (three ASP.NET controllers declare `[Route("articles")]`),
is narrowed by which of them declares *this* HTTP method.

### Consequences

A run does strictly more work than one that aborts early. The payoff is that a
tie under a specific strategy is not fatal, which is what lets `class_prefix`
and the mount strategy rescue endpoints that `path_decorator` left ambiguous.

The error a caller sees is not necessarily from the last strategy tried, which
can be surprising when debugging: it is from the most specific one that found
anything at all.

---

## ADR-013 — Naming a handler uses method-level declarations only

**Status:** accepted · `locator/handler.py`

### Context

Once the file is located, the handler's name is inferred by finding the route
declaration and taking the definition that follows it.

A class-level prefix (`@Controller('articles')`) matches the whole controller, so
"the definition that follows" is whichever function is *first in the file* — not
the one for this endpoint. That is how NestJS returned `constructor`, and how a
GET returned `createArticle`.

### Decision

Only method-level declarations are used for naming. The class prefix locates the
file (it is a locator strategy) and is never used to name.

JS and TS need an extra pattern for this: a class method carries none of the
keywords in `[function_keywords]` — `function` does not appear in
`async findAll(@Query() q)` — so without `METHOD_DEFINITION` the file is located
and the handler cannot be named.

`METHOD_DEFINITION` requires **start of line**, and applies to exactly three
extensions:

- Start of line, because the loose heuristic `\bNAME\s*\(` also matches call
  sites, and in a routes file what follows the handler is usually another call —
  `module.exports = router.routes()` — which would name the handler `routes`.
- Three extensions, because everywhere else it is wrong or unnecessary. Python,
  Ruby, Go, Rust, Kotlin and Swift do carry a keyword; Java and C# already fall
  back to the universal heuristic. Applied to all, Django's `urls.py` — where
  every line opens with `url(` — named every handler `url`.

### Consequences

A framework that declares routes only at class level cannot have its handler
named, even when its file is located. That is the intended failure: the endpoint
raises `HandlerNameNotFoundError` rather than returning the first function in the
file.

---

## ADR-014 — The keyword-less heuristic needs two guards

**Status:** accepted · `locator/handler.py`

### Context

Java and C# have no keyword before a method name, so their entry in
`[function_keywords]` is empty and `definition_regex` falls back to
`\bNAME\s*\(`. That shape is not unique to definitions: an **annotation with
arguments** has it too.

### Decision

Two guards, both only meaningful for those languages:

- `_first_definition_in` skips any match whose line starts with `[` or `@`.
  Without it, `[Authorize(AuthenticationSchemes = ...)]` sitting between the route
  decorator and the method made the handler `Authorize`.
- `_referenced_name` returns `None` outright when the extension has no
  definition keywords. Its whole safety rests on checking "is this name defined
  in this file", and with the universal heuristic that check also passes for a
  call — so any attribute on the line would pass for the handler.

### Consequences

Java and C# get less from the shortcuts than the other ten languages: they never
take the "handler named inside the declaration" path (ADR-015) and rely on the
definition that follows. Widening the heuristic for them means finding a way to
tell a definition from a call without a keyword, which regex alone does not give.

---

## ADR-015 — A handler named inside the declaration wins, if this file defines it

**Status:** accepted · `locator/handler.py`

### Context

Half a dozen frameworks put the handler *inside* the route declaration rather
than below it: `router.GET("/feed", ArticleFeed)` in Gin,
`Route::get('tags', 'TagController@index')` in Laravel. Taking "the next
definition in the file" there returns some other route's handler.

### Decision

The name referenced by the declaration itself is preferred — but only when it is
**defined in this same file**.

### Consequences

That single requirement is what makes the shortcut safe. When the reference
points outside — Koa's `ctrl.get`, where `ctrl` is a required module — nothing is
invented: the shortcut declines and the normal path continues, and if that fails
too, ADR-016 takes over.

---

## ADR-016 — Following a reference out of the routes file, and the single-definition rule

**Status:** accepted · `locator/handler.py`

### Context

Sometimes the routes file is not the controller at all. Four shapes appear in the
corpus:

| Shape | Example | Framework |
| --- | --- | --- |
| Qualified reference to a sibling | `get(listing::list_articles)` | axum |
| Chain through a `require` | `ctrl.feed.get` | Koa |
| Class and method as text | `'ArticleController@index'` | Laravel |
| Method of a typed variable | `closure: articles.getArticles` | Vapor |

### Decision

Each shape is followed, in that order, and every one of them ends in the same
check: **the name must have exactly one definition** in the repository.

The qualified reference is stricter still — the qualifier has to name a sibling
file that *also* defines the function. That double requirement is what makes it
safe: Koa's `ctrl` is a variable, finds no `ctrl` file next to it, and falls
through instead of guessing.

### Consequences

A handler called `index`, `get` or `show` will fail the single-definition rule in
almost any repository, and the endpoint is reported as not found. That is the
correct outcome under the governing rule — ambiguity resolved by guessing is how
the wrong controller reaches the LLM.

The `require` chain is followed up to `MAX_REQUIRE_HOPS` (6). Koa needs four:
router → controllers index → controller → the controller it delegates to.

---

## ADR-017 — With parameters in the path, the declaration that writes them wins

**Status:** accepted · `locator/handler.py` · `locator/matcher.py`

### Context

The wildcard standing in for `{slug}` matches any segment, so the pattern built
for `/articles/{slug}` also matches a literal `"/api/articles/feed"` — which is a
different route of the same contract. Whichever appears first in the file wins,
and `GET /articles/{slug}` returned the handler for `/feed`.

### Decision

When the contract path contains a parameter, a declaration that also writes it as
a parameter is preferred over one that does not. The check is the same in four
places — naming a handler, following a qualified reference, searching the
repository, and breaking ties between mounted modules — and it always prefers
rather than requires: a non-parameterised match is kept as a fallback when
nothing better appears.

### Consequences

The same three-line check is repeated at four call sites instead of being lifted
into a shared helper. Each site has a different notion of "the candidates" — a
name, a `(file, name)` pair, a match object — so factoring it would mean a
callback and more indirection than the check itself costs.

---

## ADR-018 — Five grammars ship with the package, seven are an optional extra

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

## ADR-019 — Languages that share a grammar's shape share its tag query

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

This is the same idea as [ADR-006](adr.md#adr-006) —`.tsx` inheriting `.ts`'s
rules in `patterns.toml`— arrived at independently in another stage, keyed by
language instead of by extension. Two tables express one thought, and a language
added to one is not added to the other.

The condition for sharing is narrower here than it looks: not "similar languages"
but "the same node types name a definition". A grammar that names definitions
differently needs its own file even if the language is a close relative.

---

## ADR-020 — The syntax gate only rejects an unusable tree

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

## ADR-021 — An `operationId` only names the handler if it names something callable

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

## ADR-022 — The tag queries and `[class_keywords]` are checked against each other

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
duplication [ADR-019](adr.md#adr-019) removed.

The suite grew by 58 cases and now compiles all twelve queries against their real
grammars, which is the check that would have caught the C# defect the day it was
written.

---

## ADR-023 — The function is cut by byte offsets, decorators included

**Status:** accepted · `extractor/function.py`

### Context

Once the handler's node is found, its source has to be handed to the LLM. The
obvious approach is line numbers: take `start_point[0]` to `end_point[0]` and
join those lines.

### Decision

The slice is `source_bytes[start_byte:end_byte]` — byte offsets from the node
itself, on the raw bytes, decoded only at the end.

Bytes and not decoded text because tree-sitter's offsets **are** byte offsets: a
multibyte character anywhere earlier in the file shifts every character index,
and slicing a `str` by those numbers returns something else. It is silent when it
happens — the snippet is merely wrong, not malformed.

The slice is then widened upward to include a decorator when the node's parent is
one. A handler without its decorator is missing the route it serves and whatever
validation the framework declares there, which is most of what the LLM needs to
infer the endpoint's contract.

### Consequences

Indentation, comments and blank lines inside the function survive exactly as
written — the LLM reads the code the way the author left it, not a reflowed
version. `ExtractedContext` still carries `start_line` / `end_line`, but as
metadata for humans, never as the way the code was obtained.

---

## ADR-024 — A handler name can be a dotted path, resolved segment by segment

**Status:** accepted · `extractor/function.py`

### Context

The handler is not always a module-level symbol. A Koa controller exports
`module.exports = { feed: { async get(ctx) {} } }` and the route points at
`ctrl.feed.get`, so the name to extract is `feed.get`. No node in the tree is
called `feed.get`.

### Decision

A target containing a dot is walked one segment at a time: find `feed`, then find
`get` **inside the subtree** the previous segment resolved to.

### Consequences

The scoping is what makes it correct rather than merely working: a file usually
has more than one `get`, and searching the whole tree for the last segment would
return whichever came first. It also means an intermediate segment must itself be
captured as a definition — which is why `typescript.scm` captures an object key
whose value is a function or an object, and only those two, so that ordinary
configuration keys do not become definitions.

---

## ADR-025 — Call detection is table-driven, and walks the tree by hand

**Status:** accepted · `tracer/call_detector.py`

### Context

Twelve grammars express one idea — a call, with or without a base — in nine
different shapes. Two obvious approaches: a branch per language, or a `.scm`
query per language like the extractor uses.

### Decision

Neither. Everything resolves through tables of node types and field names
(`CALL_NODE_TYPES`, `BASE_FIELDS`, `NAME_FIELDS`, …), and the tree is walked by
hand rather than queried.

Tables because a branch per language is a branch per language forever: adding one
means editing control flow, and the twelve shapes do not partition cleanly — they
overlap. Adding a language should be adding entries.

By hand rather than `.scm` because a query would make call detection depend on
every Golden Path grammar shipping one, and on those queries agreeing on capture
names. The tag queries already carry that coupling for definitions; extending it
to calls doubles the surface that has to stay in sync.

### Consequences

Adding a language means extending the tables and nothing else — but it also means
the tables are the only documentation of which node type belongs to which
grammar, and nothing checks that an entry is still real. A grammar that renames a
node type leaves a dead string in a frozenset, silently.

Before this was generalised, **six of the twelve languages detected zero calls**.
`expected_calls` was 0, `completion_ratio` 1.0 by definition, and the mode
`surgical` — a perfect-completeness report over a payload that was just the
controller. A detector that finds nothing does not look broken from the outside.

---

## ADR-026 — A call is reported qualified, and the tracer decides what to do with it

**Status:** accepted · `tracer/call_detector.py`

### Context

`obj.method()` can be a dependency worth following or noise. `services.process()`
is real if `services` is an import that resolved inside the repository;
`self.compute()` and `svc.charge()` are not.

The detector cannot tell: it sees one snippet and knows nothing about imports.

### Decision

The detector returns the **qualified** name, base included, and the tracer
decides. A multi-segment base collapses to its last segment — the module that
names the function — normalised to a dot: `crate::services::process()` becomes
`services.process`.

The last segment because that is what identifies the module; the earlier ones are
the path to it, which the resolver reconstructs anyway from the import. The dot
because the tracer should split on one separator, not on whichever the language
happened to use.

### Consequences

One rule at the other end — *keep it only if the base is an import that resolved
inside the repository* — drops `self.compute()` and `svc.charge()` without a
special case for either, and keeps the tracer out of the standard library and
third-party packages.

The cost is that the detector's output is not the code's own vocabulary:
`services.process` never appears literally in a Rust file. Anything comparing
detector output against source text has to account for that.

---

## ADR-027 — The snippet is reparsed on its own

**Status:** accepted · `tracer/call_detector.py`

### Context

Calls are looked for inside the extracted function, not the whole file. The
function's node is already in the file's tree, so it could be walked there.

### Decision

The snippet is parsed again, standalone, from the bytes the extractor produced.

### Consequences

Cheaper to reason about than carrying a node plus a byte range through the
tracer, and it makes the boundary literal: what gets walked is exactly what the
LLM will read.

It also costs one parse per traced function, and it introduces a problem that
does not exist in the file's own tree: some languages do not recognise their own
code without an opening marker. A bare PHP function without `<?php` parses as a
single text node and yields **no calls at all** — not an error, just silence.
`SNIPPET_PREAMBLE` prepends what the language needs. A language added later that
has the same property will look like a function with no dependencies until
someone notices.

---

## ADR-028 — Unresolved and external are different failures

**Status:** accepted · `tracer/engine.py`

### Context

A call the tracer cannot follow can mean two very different things, and only one
of them should count against the endpoint.

`completion_ratio` is `resolved / (resolved + unresolved)`, and the mode policy
reads it. Counting the wrong thing there either hides real losses or drowns every
endpoint in noise from `requests` and `console.log`.

### Decision

**Unresolved** means: this looks like a dependency of this repository and it was
not found. Something is wrong — a broken relative import, a function missing from
the file an import resolved to.

**External** means: no resolution could ever reach it, so its absence is not a
loss. Three cases end up here:

- A call with no import bringing it in and no definition in the file or its
  package. It is a parameter being invoked — `repo_type(conn)` inside
  `get_repository(repo_type)` — a local variable, or a member inherited from a
  third-party class.
- A qualified call whose qualifier turns out to be a **type** in the target file:
  `ArticleForResponse.from_orm(...)` invokes something pydantic put on the base
  class, not something this repository wrote. A missing `services.process` is the
  opposite — `services` is the file, not a definition inside it — and stays
  unresolved.
- An absolute import that did not resolve, decided earlier by `ImportScan`.

External calls are recorded on the result but excluded from the ratio.

### Consequences

The distinction rests on a guess that cannot be verified without knowing the
installed environment: a mistyped local module and a third-party package are
genuinely indistinguishable from the source alone. Both land in `external`, so a
broken local dependency of that shape does **not** lower the ratio. Closing that
gap means reading the analysed repository's declared dependencies, which is a new
per-language mechanism and deliberately out of scope.

Both classifications are recorded, so the loss is visible even when it does not
move the number.

---

## ADR-029 — Where the package is the directory, siblings are swept

**Status:** accepted · `tracer/engine.py`

### Context

In Java, Kotlin, C# and Go a symbol from the same package is used with no import
at all. `data class User` lives in `model/User.kt` and `model/Article.kt` writes
`var author: User = User()` without a single import line; in Go, `routers.go` and
`models.go` share a package and call each other unqualified.

Looking only at imports, those dependencies came out unresolved and dragged down
the `completion_ratio` of everything passing through them.

### Decision

For those four languages, a call with no import and no local definition is looked
for among the sibling files of the same directory, reusing the same sweep an
import that resolves to a folder already uses.

The sweep requires the sibling to **define** the name, confirmed on the tree.
Mentioning it is not enough, and that is not a detail: in a Go package the test
that exercises a function sorts before the file that defines it —
`unit_test.go` before `utils.go` — so a mention-based match extracted from the
wrong file and the dependency stayed unresolved anyway.

The mention survives as a cheap pre-filter, to avoid parsing the whole package.

### Consequences

Correctness now depends on the tag query capturing what the sibling defines. A
type-only Go file was invisible to this sweep until the queries were completed
([ADR-022](adr.md#adr-022)), and the failure was silent: the dependency simply
counted as unresolved.

The list of four languages is a judgement about how they resolve names, not
something derived from the grammars. A thirteenth language with package scoping
has to be added there by hand or its siblings are never swept.

---

## ADR-030 — The non-traceable table is per language and includes what is never imported

**Status:** accepted · `tracer/constants.py`

### Context

A call the tracer cannot follow is not automatically a problem: `print`, `len`,
`console.log` and `fmt.Println` are the language, not the repository. Chasing them
wastes work; counting them as unresolved sinks `completion_ratio` for every
endpoint.

### Decision

One vocabulary of non-traceable names per language, consulted only for **simple**
calls — a qualified one is already decided by whether its base is a repo import
([ADR-026](adr.md#adr-026)) — and overridden when the name is explicitly imported
or defined locally, so a repository with its own `map` still gets it traced.

The table is not just the standard library. Three groups earned their place from
concrete failures:

- **Go type conversions** — `uint(id)` is syntactically a call and no import or
  definition explains it.
- **JDK collection methods** — invoked unqualified in the double-brace idiom
  (`new HashMap<>() {{ put("tags", ...); }}`) that Spring uses to build
  responses, so they arrive as local calls and counted as unresolved in nearly
  every controller.
- **`ControllerBase` members in C#** — `Ok`, `NotFound`, `BadRequest` and the
  rest are called with no import because the class inherits them, so no
  import-based resolution can ever reach them.

### Consequences

The table is a vocabulary maintained by hand, and it is only as good as the
failures someone has already seen. A framework whose base class contributes
unqualified methods — the pattern behind two of the three groups above — will
look like a controller full of broken dependencies until its methods are added
here.

Being context-sensitive is what keeps the cost acceptable: the list can be
generous, because a repository that genuinely defines one of these names still
gets it traced.
