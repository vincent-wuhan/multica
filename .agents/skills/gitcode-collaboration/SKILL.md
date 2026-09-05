---
name: gitcode-collaboration
description: Use when working with GitCode repositories, issues, merge requests, branches, local mirrors, or mapping GitCode artifacts to Multica issues. Provides safe token, network, branch, MR, issue, and evidence-linking conventions.
metadata:
  author: benyue
  version: "1.3.0"
  argument-hint: <owner/repo> [operation]
---

# GitCode Collaboration

GitCode is the source of truth for repositories, branches, commits, issues, and merge requests. Multica is the source of truth for squad assignments, execution history, review conclusions, and delivery evidence. Never mirror the same source of truth to another provider.

## Principles

1. Keep GitCode remotes clean: always use `https://gitcode.com/<owner>/<repo>.git` or `git@gitcode.com:<owner>/<repo>.git`.
2. Never place a token in a remote URL, shell command, issue, MR, commit, prompt, or log.
3. Read `GITCODE_TOKEN` only from the agent environment or an approved secret store.
4. Use the adapter CLI rather than ad-hoc `curl` commands.
5. Treat a local mirror as a cache. Never treat it as a second source of truth.
6. Record every external artifact back on the originating Multica issue.

## Adapter CLI

The skill bundles `scripts/benyue-gitcode.mjs`. When working inside a Multica repository checkout that contains the adapter, run:

```bash
node scripts/benyue-gitcode.mjs <command> [options]
```

When the repository checkout does not contain the adapter, first locate the bundled skill file in the installed `gitcode-collaboration` skill, copy it to a task-local `scripts/benyue-gitcode.mjs`, then execute it with Node.js. Never copy or print the token while doing so.

Use `--output json` for agent consumption. Commands never print the configured token.

## Adapter Contract

- Issue and merge-request comment mutations use the GitCode v5 `body` field.
- Issue and merge-request `--number` values must be positive integers.
- `--dry-run` must not create directories, remotes, worktrees, comments, issues, or merge requests.
- Duplicate checks are fail-safe under concurrent writers: if pagination reaches the safety limit, stop instead of mutating.
- A check-then-create race remains possible when multiple agents run concurrently. Serialize mutations per repository or accept a reviewed duplicate.

## Required Task Mapping

Every implementation task must state:

```text
GitCode Owner/Repo: <owner>/<repo>
Base Branch: <branch>
Base Commit: <sha>
Target Branch: codex/<multica-issue-key>-<short-slug>
GitCode Issue: <url or pending>
GitCode MR: <url or pending>
```

On completion, add:

```text
GitCode Issue: <url>
GitCode MR: <url>
Head Commit: <sha>
Verification: PASS | FAIL | PASS WITH ISSUES
Evidence: <commands and result links>
```

## Authentication

- Prefer SSH for Git operations and API tokens only for GitCode API operations.
- For HTTPS Git operations, use an approved credential helper or the adapter's temporary askpass helper.
- Rotate any token that has appeared in a remote URL or log.

## Network

If a host has a broken global Git proxy, override it per invocation:

```bash
git -c http.proxy= -c https.proxy= <command>
```

Do not change global proxy configuration as a side effect of a project task.

## Issue Template

```markdown
## Background

<source, impact, and evidence>

## Reproduction

1. ...

## Expected

...

## Actual

...

## Evidence

- Multica issue:
- Command:
- Environment:

## Acceptance

- [ ] ...
```

## Merge Request Template

```markdown
## Purpose

...

## Links

- Multica issue:
- GitCode issue:
- Design/review task:

## Changes

- ...

## Verification

- [ ] Type check
- [ ] Tests
- [ ] Manual or smoke validation
- [ ] Security and secret review

## Rollback

...
```

## Local Mirror Workflow

Initialize:

```bash
node scripts/benyue-gitcode.mjs mirror init \
  --owner glorius --repo reviewpilot \
  --mirror /data/benyue/mirrors/reviewpilot.git
```

Refresh:

```bash
node scripts/benyue-gitcode.mjs mirror fetch \
  --mirror /data/benyue/mirrors/reviewpilot.git
```

Create an isolated worktree:

```bash
node scripts/benyue-gitcode.mjs mirror worktree add \
  --mirror /data/benyue/mirrors/reviewpilot.git \
  --path /data/benyue/worktrees/BENY-25 \
  --branch codex/beny-25-example \
  --start-point origin/sit/20260820
```

Use one worktree per Multica issue. Do not share mutable working trees between agents.

## Stop Conditions

Stop and report to the squad leader when:

- Credentials are missing, rejected, or potentially exposed.
- GitCode and Multica artifact mappings conflict.
- A merge would bypass review or explicit user authorization.
- An operation would rewrite protected history or delete production data.
