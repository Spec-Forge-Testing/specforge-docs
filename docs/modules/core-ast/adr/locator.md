# Core AST — Decision records — Locator

Part of the [Core AST decision records](index.md). Locator-stage decisions: how
a contract endpoint (an HTTP method and path) is mapped to the file and handler
that implement it — the cascade of matching strategies, the route vocabulary,
and how ambiguity is resolved without guessing.

---

## ADR-001 — Build output and dependency directories are excluded from the scan { #adr-001 }

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

## ADR-002 — The repository scan is cached per repository, and what is cached is immutable { #adr-002 }

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

## ADR-003 — The scan cache is invalidated explicitly, never automatically { #adr-003 }

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

## ADR-005 — The route vocabulary is deliberately narrow { #adr-005 }

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

## ADR-006 — An extension inherits another's rules only within the same language { #adr-006 }

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

## ADR-007 — A wildcard-only route form can name a handler, never choose a file { #adr-007 }

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

## ADR-008 — Every pattern is scoped to one language { #adr-008 }

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

## ADR-009 — Route templates are tried one at a time, never merged { #adr-009 }

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

## ADR-010 — Following a router mount is two hops, and returns a scope { #adr-010 }

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

## ADR-011 — Routes generated by a resource registration are located by convention { #adr-011 }

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

## ADR-012 — An ambiguous strategy does not abort the cascade { #adr-012 }

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

## ADR-013 — Naming a handler uses method-level declarations only { #adr-013 }

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

## ADR-014 — The keyword-less heuristic needs two guards { #adr-014 }

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

## ADR-015 — A handler named inside the declaration wins, if this file defines it { #adr-015 }

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

## ADR-016 — Following a reference out of the routes file, and the single-definition rule { #adr-016 }

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

## ADR-017 — With parameters in the path, the declaration that writes them wins { #adr-017 }

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

## ADR-049 — A route declared as a constant is expanded before matching { #adr-049 }

**Status:** accepted · `locator/scanner.py`

### Context

Java and C# let the route be declared apart and referenced from the annotation:

```java
public static final String ROUTE = "/tan";
@PostMapping(ROUTE)
```

To a route pattern that is an identifier, not a route. The endpoint was not
found, and worse: it fell back to the handler of the route without the suffix.
In `market`, `PUT /customer/cart/delivery` returned `addItem`, which serves
`PUT /customer/cart` — one endpoint handing over another's code.

### Decision

Each reference is replaced by its literal **inside annotations only**, before
the patterns run. When the constant lives in another class — `Constant.V1`,
`Constants.API_RESOURCE_CONTRIBUTORS` — a few levels are climbed looking for
`<Class>.java`: the constants class is usually a sibling of the package that uses
it, not an arbitrary file of the repository.

Java also allows writing the modifier once and chaining constants with commas, so
the declaration and the `name = "value"` pairs inside it are read separately.

### Consequences

Restricting expansion to annotations is what makes it safe: outside them the same
identifier may be a method's name — a constant `B` and a method `B()` coexist
without trouble — and substituting it would make the method unfindable. The
unscoped version did exactly that.

Resolving more routes also surfaces ambiguity that was hidden. In
`cwa-verification` the internal controller declares the same full route as the
external one; while its constant did not resolve it never competed, and now
`POST /version/v1/testresult` is genuinely ambiguous — which by
[ADR-016](#adr-016) is the right answer.

Measured against 349 endpoints derived from source: 305 → 313.

---

## ADR-050 — The route table grows by form, and each form belongs to one language { #adr-050 }

**Status:** accepted · `locator/patterns.toml`

### Context

Measured against expectations derived from source rather than captured from the
pipeline, the locator sat at 87%. The misses were not exotic: they were ordinary
ways of writing a route that the table did not know.

### Decision

Four forms were added, each to the languages that actually produce it:

- **JAX-RS in Java.** The table only knew Spring, so no `@Path` project located
  anything — `restcountries` was 0/22 and `scout-api` 4/49. The verb and the
  route are separate adjacent annotations, and both orders occur.
- **`@RequestMapping` without `method`.** Spring treats it as the handler of
  *every* verb, and webgoat's contract declares all seven for those routes; only
  the GET was being found.
- **The route inside an array.** `value = {"/x"}` in Java, and Kotlin's own two
  spellings, `arrayOf("/x")` and `["/x"]`. `tracking-system` writes every route
  that way and located none of its 67.
- **Attributes in any order.** Java does not order annotation attributes;
  `@RequestMapping(method = POST, value = "/x")` is as valid as the reverse.

### Consequences

87% → 91% on the derived corpus, and the failures that remain are no longer of
this kind.

Two guards are what keep the additions from costing more than they give. The
JAX-RS patterns require the method to have a **body**, because a REST client
interface declares the same annotations for the route it *consumes* — without
that, microcks' connector outbid its own controller. And `@RequestMapping` with
no `method` must not be followed by a class declaration, because the class-level
annotation has no `method` either; without that guard the handler became the
first function in the file.

Each form is scoped to the languages whose grammar produces it. Widening Java's
pattern to accept `arrayOf` would be accepting something Java never writes, and
every such widening is a chance to match the wrong file.
