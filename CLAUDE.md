@AGENTS.md

Repository skills for Claude Code are in `.claude/skills`: `review-change` for the review CI runs, `security-sweep` for the weekly whole-repository security sweep, `sweep-triage` for a maintainer to triage its findings, `adr` for architecture decisions, `writing-pr-descriptions` for pull request text, and `genki-admin` for working on services in a running genki.

The hooks in `.claude/settings.json` (`scripts/agent-hook.ts`) run prettier on every file you edit, and block `git push` and `gh pr create`, and the end of a turn once, while there is a change against origin/main and `npm run verify` has not passed on the working tree.
