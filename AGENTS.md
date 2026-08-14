# AGENTS.md

## Working rules (apply to every task in this repository)

1. **Scratch work lives outside the repo.**
   - Never use the project repository for scratch files, temporary scripts, probes, generated output, or experiments.
   - Create and use a scratch parent folder **outside** this repo for anything like that. Default scratch folder: `/tmp/reasonix-scratch`.
   - Always clean up your own scratch files there when done. Never leave leftovers inside the repo.

2. **Never clear, delete, or modify `.reasonix`.**
   - The `.reasonix` directory/files inside the repository hold Reasonix state and must never be cleared, deleted, edited, or truncated.
   - `.reasonix/` is **git-ignored** (listed in `.gitignore`) to keep `git status` and commits clean — but the folder itself on disk must be left untouched.

3. **Never clear inside any repo.**
   - Do not delete or clean up files inside this repository (or any repository) beyond the exact, intended changes for the task.
   - Any "cleanup" of intermediate/generated artifacts happens only in the scratch folder, never inside a repo.
