# Spec Forge Docs

MkDocs (Material theme) source for the Spec Forge documentation site, published to
`spec-forge-testing.github.io/specforge-docs`. The code it documents lives in the sibling
`llm-pbt-agent` repository.

## Run locally

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt      # macOS/Linux
.venv/Scripts/mkdocs serve                        # Windows
# .venv/bin/mkdocs serve                           # macOS/Linux
```

Then open `http://127.0.0.1:8000`.

## Structure

```
specforge-docs/
├── mkdocs.yml           # site config, nav, Material theme
├── requirements.txt
└── docs/
    ├── index.md
    ├── user-guide/       # installing and running Spec Forge
    ├── architecture/     # conceptual overview of the pipeline
    ├── developer-guide/  # contributing and CLI internals
    ├── modules/          # per-package reference, nested under Developer Guide in the nav
    └── testing/          # tests-repos corpora, nested under Developer Guide in the nav
```
