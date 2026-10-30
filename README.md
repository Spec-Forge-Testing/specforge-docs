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
    ├── index.md                 # choose a path and documentation map
    ├── user-guide/              # task-oriented product documentation
    ├── architecture/            # conceptual overview of the pipeline
    ├── developer-guide/         # contributing and implementation guidance
    ├── modules/                 # per-package reference and decision records
    └── testing/                 # tests-repos corpora
```

The site follows progressive disclosure: getting-started and usage pages come first, while
reference material is grouped under the Developer Guide.