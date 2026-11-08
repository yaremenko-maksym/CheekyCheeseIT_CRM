---
paths:
  - '**/*.sql'
  - '**/*.sh'
  - '**/*.json'
  - 'graphify-out/**'
---

# Rule: graphify — the code graph for SQL, shell and JSON

**Status:** Path-scoped (loads on `.sql` / `.sh` / `.json` / `graphify-out/**`); also read by hand
before any `graphify` command — the pointer lives in `mcp-first.md`.
**Applies to:** All agents + Master

> Moved verbatim out of `mcp-first.md` (2026-11-08). Rationale: `docs/architecture/rules-rationale/mcp-first.md`

---

## graphify alongside codegraph (by file type)

graphify is an **addition**: built locally, code-only, by `scripts/devops/build-graphify.sh` into the gitignored `graphify-out/`.

| File type                                   | Tool                                                                                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `.ts` / `.tsx` / `.js`, **and their specs** | **codegraph** (MCP, PRIMARY) — navigation, callers, blast radius, live-watched                                                                 |
| `.sql`, `.sh`, `.json`                      | **graphify** (CLI) — codegraph indexes none of them                                                                                            |
| `.yaml`                                     | **codegraph** — graphify does not cover yaml                                                                                                   |
| `.md`                                       | **neither tool.** graphify does not index markdown (that would need a model pass, declined) and codegraph does not either; use `Read` / `Grep` |

- Rebuild before relying on it: it does not watch files. `graph.json` records `built_at_commit`.
- Do not register `graphify-mcp` (a second server adds its tool set to every agent's context).
- Run `graphify affected "<symbol>" --depth 1` for "who calls this"; depth 2 prints transitive
  callers formatted like direct ones.
- Shell coverage is uneven: an empty answer on dispatch-through-variable scripts means "unknown", not "nothing calls it".
- Always run `graphify extract` with `--code-only`; without it the tool sends file contents to a model.
  Never pass `--no-gitignore` or `--postgres` (the first indexes gitignored files, the second reads the
  live database). Never run `graphify label`, and never run `cluster-only` without `--no-label` (both
  call a model). The build script exists so nobody types the command by hand.
