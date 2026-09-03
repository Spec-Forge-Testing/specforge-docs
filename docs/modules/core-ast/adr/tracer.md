# Core AST — Decision records — Tracer

Part of the [Core AST decision records](index.md). Tracer-stage decisions: how
the handler's dependencies are followed — call detection, import analysis and
resolution across nine languages — to build the context bundle.

---

## ADR-025 — Call detection is table-driven, and walks the tree by hand { #adr-025 }

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

## ADR-026 — A call is reported qualified, and the tracer decides what to do with it { #adr-026 }

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

## ADR-027 — The snippet is reparsed on its own { #adr-027 }

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

## ADR-028 — Unresolved and external are different failures { #adr-028 }

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

## ADR-029 — Where the package is the directory, siblings are swept { #adr-029 }

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
([ADR-022](ast-builder.md#adr-022)), and the failure was silent: the dependency simply
counted as unresolved.

The list of four languages is a judgement about how they resolve names, not
something derived from the grammars. A thirteenth language with package scoping
has to be added there by hand or its siblings are never swept.

---

PHP se suma después: en PSR-4 el namespace **es** la carpeta, así que la clase
padre del mismo namespace se usa sin `use`, y ahí viven los métodos que el
handler llama por `$this->`.

## ADR-030 — The non-traceable table is per language and includes what is never imported { #adr-030 }

**Status:** accepted · `tracer/constants.py`

### Context

A call the tracer cannot follow is not automatically a problem: `print`, `len`,
`console.log` and `fmt.Println` are the language, not the repository. Chasing them
wastes work; counting them as unresolved sinks `completion_ratio` for every
endpoint.

### Decision

One vocabulary of non-traceable names per language, consulted only for **simple**
calls — a qualified one is already decided by whether its base is a repo import
([ADR-026](#adr-026)) — and overridden when the name is explicitly imported
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

---

## ADR-031 — Imports are split three ways, not two { #adr-031 }

**Status:** accepted · `import_analyzer/filtering.py`

### Context

An import either resolves to a file inside the repository or it does not. The
two-way split loses the distinction that matters: an unresolved import can be a
third-party library or a broken local dependency, and only the second is a
problem.

### Decision

`ImportScan` keeps four fields, from three outcomes:

- **resolved inside the repo and used in the snippet** → `relevant`, the only
  traceable ones, plus `resolved_paths` alongside them.
- **relative and unresolved** → `broken_local`. A relative import admits no
  third-party reading: `from .services import x` can only mean a file of this
  repository, so failing to find it is a real loss and counts against the ratio.
- **absolute and unresolved** → `external`. It may be `requests` or a mistyped
  local module, and the source alone cannot say which
  ([ADR-028](#adr-028)).

`resolved_paths` is carried rather than re-derived because resolution costs I/O
and already happened here. The fallback planner used to rebuild those paths with
its own extension heuristic, which knew six extensions and no ecosystem layouts,
and therefore found nothing in eight of the twelve languages.

### Consequences

The relative/absolute test is a proxy for intent, and it is only as good as the
language's conventions. In Go and Java every import is absolute, so a broken
local dependency there always lands in `external` and never lowers the ratio —
the whole `broken_local` bucket is effectively Python, TypeScript and Ruby.

---

## ADR-032 — A file never imports itself { #adr-032 }

**Status:** accepted · `import_analyzer/filtering.py`

### Context

Resolution of an absolute import starts from the importing file's own directory.
So `app/services/jwt.py` writing `import jwt` to use PyJWT resolved to
**itself**.

The third-party library then passed for a local module, and everything hanging
off it — every `jwt.encode`, `jwt.decode` — became a dependency of a file that
does not define them, and counted as broken.

### Decision

A resolution that lands on the importing file is discarded, and the import
continues down the classification as if it had not resolved.

### Consequences

A file that genuinely imports itself does not exist in any of the twelve
languages, so nothing legitimate is lost. What this does not cover is the same
collision one directory up: a `services/jwt.py` next to a `services/auth.py`
that writes `import jwt` still shadows the library, and the only way to tell is
knowing what is installed.

---

## ADR-033 — A grouped import becomes one name per symbol { #adr-033 }

**Status:** accepted · `import_analyzer/analyzers.py`

### Context

Several languages bring in more than one symbol per statement:
`use axum::{Json, Router}`, `import { a, b } from 'm'`. Read literally, the
imported name of the first is the string `{Json, Router}`.

### Decision

The group is expanded: one entry per symbol, with the module path shared.

### Consequences

Without it neither `Json` nor `Router` exists for the tracer, so a call to
`Json(...)` finds no import and counts as a **broken dependency** rather than a
third-party library — the failure is not a missed trace, it is a wrong
classification that lowers `completion_ratio`. The local case is worse:
`use crate::http::{ApiContext, Error}` left neither name traceable.

---

## ADR-034 — Import parsing reads grammar fields, never positions { #adr-034 }

**Status:** accepted · `import_analyzer/analyzers.py`

### Context

`from x.y import a` has two parts to tell apart: the module path and the imported
name. Both are identifiers, and the tempting way to separate them is by position
— first child is the module, the rest are names — or by comparing their text.

### Decision

Both come from named fields: `module_name` for the path, `name` for each imported
symbol. The declarative family does the same with `STATEMENT_TYPES` and
`PATH_TYPES`.

### Consequences

Position and text comparison both break on `from deep import deep`, where the two
parts are the same string: the name was dropped and the dependency was never
traced. Idiomatic Python is full of that shape — `from config import config`,
`from settings import settings`.

The cost is that every analyzer is tied to its grammar's field names, which are
not stable across tree-sitter versions the way node types roughly are. A field
rename does not raise: `child_by_field_name` returns `None` and the import
silently disappears.

---

## ADR-035 — Nine resolvers, one template, two hooks { #adr-035 }

**Status:** accepted · `resolver/`

### Context

Nine languages need an import turned into a path on disk. They differ in
separator, extension, and where a project keeps its source — but the shape of the
work is identical: build candidate paths, return the first that exists.

### Context of the alternative

Writing nine independent resolvers means nine copies of that loop, and nine
places to fix when the loop is wrong.

### Decision

One `PathResolver` template with exactly **two** hooks:

- `_bases()` — which paths to try, and in what order.
- `_probe()` — what counts as found.

Everything else is class attributes: separator, extensions, package files, index
files, search subdirectories. Java, C# and Kotlin override neither hook — they
are attributes only.

`resolve()` takes the whole `ImportEntry`, not pre-split arguments, so a resolver
that needs `is_relative` or `relative_level` reads them itself instead of the
caller branching on language before calling.

### Consequences

Two hooks is a bet that the variation between languages falls on exactly those
two axes. It has held for nine, but it is a ceiling: a language that needs to
decide *after* probing — try a path, look inside the file, then choose — has no
place to do it without a third hook or a full override.

`resolve()` returning `Path | None` rather than raising keeps "not found on disk"
as the ordinary outcome it is for any third-party import;
`UnresolvableDependencyError` is reserved for a language with no resolver at all.

---

## ADR-036 — An import can resolve to a directory, or to an index file { #adr-036 }

**Status:** accepted · `resolver/strategies.py`

### Context

Not every import names a file. `from app.services import x` names a Python
package; `use crate::http` names a Rust module; `import "example.com/x/pkg"`
names a Go package. And in JS/TS, `from './utils'` names a *directory* whose
`index.ts` is the file meant.

### Decision

Two different outcomes, declared per language:

- `PACKAGE_FILES` (`__init__.py`, `mod.rs`) — the presence of that file makes the
  import resolve to the **directory**. No single file represents the package, so
  handing back one of them would be arbitrary.
- `INDEX_FILES` (`index.ts`, `index.js`) — the presence makes it resolve to
  **that file**, because in JS/TS the index *is* the module.

Go always resolves to a directory; Swift resolves to a directory or to the
file of the same name.

### Consequences

A resolved path is not necessarily a file, and every consumer has to handle both.
The tracer sweeps a directory for the definition it is after
([ADR-029](#adr-029)), and the fallback bundle expands it into its source
files — which it did not always do: `_try_add` required `is_file()`, so Go
packages, Python packages, Rust modules and Swift modules were dropped in
silence, in eight of the twelve languages.

---

## ADR-046 — `self` is not an external base, it is this file { #adr-046 }

**Status:** accepted · `tracer/engine.py`

### Context

A qualified call survives only if its base is an import that resolved inside the
repository ([ADR-026](#adr-026)). `self` is not an import, so
`self.get_queryset()` was discarded alongside `svc.charge()`.

That rule was written from the shape of a module-level handler. In a
class-oriented framework it is exactly backwards: `self.x` is the **only** way a
handler reaches its own dependencies.

### Decision

The instance pronoun — `self`, `this`, `cls`, `$this` — resolves as a local
definition, which is what it is: a method of the same file.

### Consequences

Django went from tracing **zero** of its 19 endpoints to seven. Nothing else
moved: no endpoint changed controller or handler, because this does not touch
where the handler is, only how much context is gathered from it.

The four other frameworks that trace nothing — ASP.NET, Laravel, Rails, Vapor —
were not fixed by this, and each fails differently: an instance field as
qualifier (`mediator.Send`), a member of an imported type
(`Article.loadRelations`), and in Rails a controller so thin that there is
genuinely almost nothing of the repository to trace.

---

## ADR-047 — A PSR-4 prefix maps to the directory, not to one inside it { #adr-047 }

**Status:** accepted · `resolver/strategies.py`

### Context

A PSR-4 prefix names where the code starts. With `"App\": "app/"`, the class
`App\Article` lives in `app/Article.php`.

The resolver kept the first segment and looked for `app/App/Article.php`, so
**no Laravel import resolved** and all three in a controller counted as
third-party libraries.

### Decision

A candidate without the prefix is tried too, **last** — so a path that exists as
written still wins first.

### Consequences

`Illuminate\Http\Request` still returns `None`, which is correct: it is genuinely
external.

This moves no metric on its own. The call that exposes the case,
`Article::loadRelations()`, is an Eloquent scope: the method is defined as
`scopeLoadRelations` and the framework drops the prefix when invoking it. But
without the import resolving there was no way to reach that point at all — which
is worth recording, because a change that moves no number is the one someone
reverts believing it does nothing.

---

## ADR-052 — El vocabulario de llamadas se amplía por evidencia { #adr-052 }

**Status:** accepted · `tracer/constants.py`

Cada gramática escribe `a.b()` a su manera y la tabla conocía solo algunas: se
agregan al aparecer —`member_call_expression` de PHP, `field_access` y el `this`
solo de Java, `field_expression` de Rust con su receptor bajo `value`, la
referencia `this::x`, y el pronombre `super`, cuyo tipo es la superclase—.
También entra el patrón `receptor . nombre (` leído entre los tokens de un
macro, porque tree-sitter no le da estructura a lo que un macro recibe.

Sin la entrada de Rust **ninguna** llamada a método del lenguaje se veía. Es lo
que [ADR-025](#adr-025) anticipa: agregar un lenguaje es agregar entradas.

---

## ADR-053 — Del receptor a su tipo, y del tipo a su archivo { #adr-053 }

**Status:** accepted · `tracer/engine.py`, `cte/constants.py`

Un controlador llama por el campo inyectado y no por el tipo, así que se sigue
el tipo declarado hasta su import. Cuando nada declara el tipo, lo identifica el
nombre del receptor —`profile` → `Profile`— exigiendo que haya **exactamente
uno** así y que **además defina el método**: pedir solo lo segundo recuperaba 10
dependencias metiendo 172 falsas.

El archivo del tipo es el que se llama como él o, si ninguno, el único que lo
declara: un archivo por tipo es convención de Swift y Java, no de Django.
