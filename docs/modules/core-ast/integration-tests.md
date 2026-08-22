# Testing `core_ast`

Two suites, answering different questions. Neither replaces the other.

| Suite | Where | What it proves |
| --- | --- | --- |
| Unit | `lib/core_ast/tests/` | Each function behaves as specified, in isolation |
| Corpus | `tests-repos/tests/core_ast/` | The whole pipeline finds real handlers in real code |

## Unit suite

601 tests, 88% coverage, run in a container so nothing has to be installed:

```bash
docker-compose --profile test build core-ast
docker-compose --profile test run --rm core-ast
```

A single file or test:

```bash
docker-compose --profile test run --rm --entrypoint python core-ast \
  -m pytest tests/test_locator/test_matcher.py -q --no-cov
```

**Optional grammars.** Seven of the twelve languages ship as the `golden-path`
extra ([ADR-018](adr.md#adr-018)). A test that needs one must be marked, or it
passes locally and fails in CI, which installs only the base dependencies:

```python
@pytest.mark.requires_grammar("java")
def test_finds_java_file(self, tmp_path): ...
```

22 tests carry that marker and are skipped in CI.

## Corpus suite

The measurement of record: 12 RealWorld implementations × 19 endpoints, one test
per implementation per CLI seam.

```bash
cd tests-repos/tests && ./run.sh core_ast -q
```

It mounts the working copy read-only, so it always tests uncommitted changes. It
enters through `specforge_cli.services` — `run_static_trace` and
`extract_endpoint_contexts` — which means it exercises `contract_engine` and
`core_ast` chained, not `core_ast` alone.

Each run rewrites `tests/core_ast/output/`, in the same projection as
`esperado/`, so the two diff line by line:

```bash
diff core_ast/esperado/run_static_trace/go_gin.json \
     core_ast/output/run_static_trace/go_gin.json
```

**Today: 227 of 228 endpoints resolve.** The one failure is `POST /users` in
`ruby_rails`, whose expectation is hand-written prose about Devise providing the
route — closing it is a decision about the fixture, not about the code.

## What 24/24 does not prove

The expectations record the controller and the function name. They do **not**
record which bytes were extracted, so a change that returns the same function
from the same file with a different slice passes unnoticed — as does a change in
the dependency chain or the mode.

When touching the tag queries, the extractor or the tracer, snapshot the run
before and after and compare:

```python
for r in analyze_endpoints(endpoints, repo_root):
    if r.ok:
        a = r.analysis
        print(a.locator.filepath.name, a.target_function,
              hashlib.sha1(a.extracted.raw_code.encode()).hexdigest()[:10],
              len(a.tracer.dependency_chain), a.tracer.mode)
```

That is how the tag-query completion ([ADR-022](adr.md#adr-022)) was verified as
behaviour-preserving: 24/24 stayed green through a change that did alter results,
and only the hashes showed it.

## What neither suite covers

RealWorld is *one* contract implemented twelve times in small demo apps. The
repository holds two other corpora — 36 EMB specs and 10 production APIs under
`polyglot/` — and neither reaches `core_ast`; both feed `contract_engine` only.

The package is therefore well covered in breadth of language and untested at
repository scale. Measured: the locator over the first 8 endpoints of EMB's
`familie-ba-sak` (Kotlin/Spring, 7 410 files) gives 6 located, 0 missing and **2
ambiguous** — a failure mode that does not occur once in RealWorld's 228.
