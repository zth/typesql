# Changelog

This changelog tracks ReScript-related changes only.

## Unreleased

### ReScript

- Added `typesql rescript` to generate ReScript from a SQL string or stdin.
- Added `typesql daemon` for long-lived on-demand ReScript generation.
- SQLite ReScript generation now caches prepared statements for (relevant) static generated queries when using `better-sqlite3` or `bun:sqlite`.
