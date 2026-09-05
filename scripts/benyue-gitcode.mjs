#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdir,
  readFile,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const DEFAULT_API_BASE = "https://gitcode.com/api/v5";
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGES = 20;

class CliError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.details = details;
  }
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }

    const flag = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[flag] = true;
      continue;
    }

    flags[flag] = next;
    index += 1;
  }

  return { positional, flags };
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`Missing required option: --${name}`);
  }
  return value;
}

function requirePositional(positional, index, name) {
  const value = positional[index];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`Missing required command argument: ${name}`);
  }
  return value;
}

function requirePositiveIntegerFlag(flags, name) {
  const value = requireFlag(flags, name);
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new CliError(`--${name} must be a positive integer`);
  }
  return value;
}

function requireRepo(flags) {
  const owner = requireFlag(flags, "owner");
  const repo = requireFlag(flags, "repo");
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new CliError("Invalid owner or repository name");
  }
  return { owner, repo };
}

function normalizeOutput(flags) {
  const output = flags.output === "table" ? "table" : "json";
  return output;
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function dedupeMarker(key) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(key)) {
    throw new CliError("--dedupe-key may only contain letters, numbers, dot, colon, underscore, and hyphen");
  }
  return `<!-- benyue-gitcode-dedupe:${key} -->`;
}

function withDedupeMarker(body, key) {
  if (typeof key !== "string") {
    return body;
  }
  const marker = dedupeMarker(key);
  return body.includes(marker) ? body : `${marker}\n\n${body}`;
}

function redact(value, token) {
  let result = value;
  if (token) {
    result = result.split(token).join("[REDACTED]");
  }
  return result
    .replaceAll(/oauth2:[^\s@]+@/gi, "oauth2:[REDACTED]@")
    .replaceAll(/(access_token|refresh_token|private[_-]?token)=([^&\s"'<>`]+)/gi, "$1=[REDACTED]")
    .replaceAll(/"(access_token|refresh_token|private[_-]?token)"\s*:\s*"[^"]+"/gi, '"$1":"[REDACTED]"');
}

function redactValue(value, token) {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, token));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactValue(item, token)]),
    );
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return JSON.stringify(redactValue(parsed, token));
      }
    } catch {
      return redact(value, token);
    }
  }
  return value;
}

function responseEnvelope({ data, provider = "gitcode", owner, repo, extra = {} }) {
  return {
    success: true,
    provider,
    ...(owner ? { owner } : {}),
    ...(repo ? { repo } : {}),
    data,
    error: null,
    ...extra,
  };
}

function printResult(result, output) {
  if (output === "table") {
    printTable(result.data);
    return;
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function printTable(data) {
  if (!Array.isArray(data)) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    return;
  }

  if (data.length === 0) {
    process.stdout.write("No results\n");
    return;
  }

  const columns = ["number", "state", "title", "html_url", "url", "sha"];
  const rows = data.map((item) => columns.map((column) => String(item?.[column] ?? "")));
  const widths = columns.map((column, index) => Math.max(column.length, ...rows.map((row) => row[index].length)));
  const header = columns.map((column, index) => column.padEnd(widths[index])).join("  ");
  process.stdout.write(`${header}\n`);
  for (const row of rows) {
    process.stdout.write(`${row.map((cell, index) => cell.padEnd(widths[index])).join("  ")}\n`);
  }
}

function printError(error, flags = {}) {
  const token = process.env.GITCODE_TOKEN;
  const output = normalizeOutput(flags);
  const details = error instanceof CliError ? error.details : undefined;
  const envelope = {
    success: false,
    provider: "gitcode",
    data: null,
    error: redact(error?.message ?? "Unknown error", token),
    ...(details === undefined ? {} : { details: redactValue(details, token) }),
  };
  if (output === "json") {
    process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    process.stderr.write(`${envelope.error}\n`);
  }
}

async function readBodyFile(flags) {
  const file = requireFlag(flags, "body-file");
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    throw new CliError(`Unable to read body file: ${file}`, { cause: error.code });
  }
}

function apiBase() {
  return (process.env.GITCODE_API_BASE ?? DEFAULT_API_BASE).replace(/\/$/, "");
}

function buildUrl(pathname, query = new URLSearchParams()) {
  const url = new URL(`${apiBase()}${pathname}`);
  for (const [key, value] of query.entries()) {
    url.searchParams.set(key, value);
  }
  return url;
}

async function requestGitCode(pathname, { method = "GET", query, form } = {}) {
  const token = process.env.GITCODE_TOKEN;
  if (!token) {
    throw new CliError("GITCODE_TOKEN is not configured in the execution environment");
  }

  const url = buildUrl(pathname, query);
  let response;
  let lastError;
  const retryLimit = method === "GET" ? 3 : 1;
  for (let attempt = 1; attempt <= retryLimit; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          "PRIVATE-TOKEN": token,
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: controller.signal,
      });
      if (attempt < retryLimit && (response.status === 429 || response.status >= 500)) {
        lastError = new CliError(`GitCode API returned HTTP ${response.status}; retrying`, {
          status: response.status,
          attempt,
        });
        await sleep(200 * 2 ** (attempt - 1));
        continue;
      }
      break;
    } catch (error) {
      lastError = error;
      if (attempt >= retryLimit || method !== "GET") {
        break;
      }
      await sleep(200 * 2 ** (attempt - 1));
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!response) {
    throw new CliError(`GitCode API request failed after ${retryLimit} attempt(s)`, {
      cause: lastError?.name ?? "unknown",
    });
  }

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = typeof data === "object" && data?.error_message
      ? data.error_message
      : `GitCode API returned HTTP ${response.status}`;
    throw new CliError(message, { status: response.status, response: data });
  }

  return data;
}

async function requestAll(pathname, query = new URLSearchParams(), perPage = DEFAULT_PAGE_SIZE) {
  const results = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageQuery = new URLSearchParams(query);
    pageQuery.set("page", String(page));
    pageQuery.set("per_page", String(perPage));
    const chunk = await requestGitCode(pathname, { query: pageQuery });
    if (!Array.isArray(chunk)) {
      return chunk;
    }
    results.push(...chunk);
    if (chunk.length < perPage) {
      break;
    }
    if (page === MAX_PAGES) {
      throw new CliError(`GitCode API pagination reached the ${MAX_PAGES}-page safety limit`);
    }
  }
  return results;
}

async function showRepo(flags) {
  const { owner, repo } = requireRepo(flags);
  const data = await requestGitCode(`/repos/${owner}/${repo}`);
  return responseEnvelope({ data, owner, repo });
}

async function listIssues(flags) {
  const { owner, repo } = requireRepo(flags);
  const query = new URLSearchParams();
  if (typeof flags.state === "string") query.set("state", flags.state);
  if (typeof flags.labels === "string") query.set("labels", flags.labels);
  const perPage = Number(flags["per-page"] ?? DEFAULT_PAGE_SIZE);
  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) {
    throw new CliError("--per-page must be an integer between 1 and 100");
  }
  const data = await requestAll(`/repos/${owner}/${repo}/issues`, query, perPage);
  return responseEnvelope({ data, owner, repo });
}

async function createIssue(flags) {
  const { owner, repo } = requireRepo(flags);
  const title = requireFlag(flags, "title");
  const body = await readBodyFile(flags);
  const form = { title, body };
  if (typeof flags.labels === "string") form.labels = flags.labels;

  if (flags["dry-run"]) {
    return responseEnvelope({ data: { title, labels: form.labels ?? null, body }, owner, repo, extra: { dryRun: true } });
  }

  if (!flags["allow-duplicate"]) {
    const openIssues = await requestAll(
      `/repos/${owner}/${repo}/issues`,
      new URLSearchParams({ state: "open", search: title, per_page: "100" }),
      100,
    );
    const duplicate = openIssues.find((issue) => issue.title === title);
    if (duplicate) {
      return responseEnvelope({ data: duplicate, owner, repo, extra: { duplicate: true } });
    }
  }

  const data = await requestGitCode(`/repos/${owner}/${repo}/issues`, { method: "POST", form });
  return responseEnvelope({ data, owner, repo });
}

async function commentIssue(flags) {
  const { owner, repo } = requireRepo(flags);
  const number = requirePositiveIntegerFlag(flags, "number");
  const body = await readBodyFile(flags);
  const finalBody = withDedupeMarker(body, flags["dedupe-key"]);
  const commentPath = `/repos/${owner}/${repo}/issues/${number}/comments`;

  if (flags["dry-run"]) {
    return responseEnvelope({ data: { number, body: finalBody }, owner, repo, extra: { dryRun: true } });
  }

  if (typeof flags["dedupe-key"] === "string") {
    const existing = await requestAll(commentPath);
    const marker = dedupeMarker(flags["dedupe-key"]);
    const duplicate = existing.find((comment) => String(comment.body ?? "").includes(marker));
    if (duplicate) {
      return responseEnvelope({ data: duplicate, owner, repo, extra: { duplicate: true } });
    }
  }

  const form = { body: finalBody };
  const data = await requestGitCode(commentPath, { method: "POST", form });
  return responseEnvelope({ data, owner, repo });
}

async function listMergeRequests(flags) {
  const { owner, repo } = requireRepo(flags);
  const query = new URLSearchParams();
  if (typeof flags.state === "string") query.set("state", flags.state);
  if (typeof flags.head === "string") query.set("head", flags.head);
  if (typeof flags.base === "string") query.set("base", flags.base);
  const data = await requestAll(`/repos/${owner}/${repo}/pulls`, query);
  return responseEnvelope({ data, owner, repo });
}

async function createMergeRequest(flags) {
  const { owner, repo } = requireRepo(flags);
  const title = requireFlag(flags, "title");
  const head = requireFlag(flags, "head");
  const base = requireFlag(flags, "base");
  const body = await readBodyFile(flags);

  if (flags["dry-run"]) {
    return responseEnvelope({ data: { title, head, base, body }, owner, repo, extra: { dryRun: true } });
  }

  if (!flags["allow-duplicate"]) {
    const openRequests = await requestAll(
      `/repos/${owner}/${repo}/pulls`,
      new URLSearchParams({ state: "open", head, base }),
    );
    const duplicate = openRequests.find((request) => request.head?.ref === head && request.base?.ref === base);
    if (duplicate) {
      return responseEnvelope({ data: duplicate, owner, repo, extra: { duplicate: true } });
    }
  }

  const data = await requestGitCode(`/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    form: { title, head, base, body },
  });
  return responseEnvelope({ data, owner, repo });
}

async function commentMergeRequest(flags) {
  const { owner, repo } = requireRepo(flags);
  const number = requirePositiveIntegerFlag(flags, "number");
  const body = await readBodyFile(flags);
  const finalBody = withDedupeMarker(body, flags["dedupe-key"]);
  const commentPath = `/repos/${owner}/${repo}/pulls/${number}/comments`;

  if (flags["dry-run"]) {
    return responseEnvelope({ data: { number, body: finalBody }, owner, repo, extra: { dryRun: true } });
  }

  if (typeof flags["dedupe-key"] === "string") {
    const existing = await requestAll(commentPath);
    const marker = dedupeMarker(flags["dedupe-key"]);
    const duplicate = existing.find((comment) => String(comment.body ?? "").includes(marker));
    if (duplicate) {
      return responseEnvelope({ data: duplicate, owner, repo, extra: { duplicate: true } });
    }
  }

  const data = await requestGitCode(commentPath, { method: "POST", form: { body: finalBody } });
  return responseEnvelope({ data, owner, repo });
}

async function checkBranch(flags) {
  const { owner, repo } = requireRepo(flags);
  const branch = requireFlag(flags, "branch");
  const data = await requestGitCode(`/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`);
  return responseEnvelope({ data, owner, repo });
}

function publicHttpsUrl(owner, repo) {
  return `https://gitcode.com/${owner}/${repo}.git`;
}

function gitUrl(owner, repo) {
  if (process.env.GITCODE_USE_SSH === "1") {
    return `git@gitcode.com:${owner}/${repo}.git`;
  }
  return publicHttpsUrl(owner, repo);
}

function gitEnv() {
  const env = { ...process.env };
  env.GIT_CONFIG_COUNT = "4";
  env.GIT_CONFIG_KEY_0 = "http.proxy";
  env.GIT_CONFIG_VALUE_0 = "";
  env.GIT_CONFIG_KEY_1 = "https.proxy";
  env.GIT_CONFIG_VALUE_1 = "";
  env.GIT_CONFIG_KEY_2 = "credential.helper";
  env.GIT_CONFIG_VALUE_2 = "";
  env.GIT_CONFIG_KEY_3 = "core.hooksPath";
  env.GIT_CONFIG_VALUE_3 = "/dev/null";
  return env;
}

async function createAskpass() {
  if (process.env.GITCODE_USE_SSH === "1") {
    return null;
  }
  const token = process.env.GITCODE_TOKEN;
  if (!token) {
    throw new CliError("GITCODE_TOKEN is required for HTTPS mirror operations");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "benyue-gitcode-"));
  const askpass = path.join(directory, "askpass.sh");
  const script = [
    "#!/bin/sh",
    'case "$1" in',
    '*Username*) printf "oauth2\\n" ;;',
    '*Password*) printf "%s\\n" "$GITCODE_TOKEN" ;;',
    '*) printf "\\n" ;;',
    "esac",
  ].join("\n");
  await writeFile(askpass, script, { mode: 0o700 });
  return { directory, askpass };
}

async function runGit(args, { cwd } = {}) {
  const askpass = await createAskpass();
  try {
    const env = gitEnv();
    if (askpass) {
      env.GIT_ASKPASS = askpass.askpass;
      env.GIT_TERMINAL_PROMPT = "0";
    }
    const result = spawnSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 32,
    });
    if (result.error) {
      throw new CliError(`Unable to execute git: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new CliError(redact(output || `git exited with ${result.status}`, process.env.GITCODE_TOKEN));
    }
    return result.stdout.trim();
  } finally {
    if (askpass) {
      await rm(askpass.directory, { recursive: true, force: true });
    }
  }
}

async function mirrorInit(flags) {
  const { owner, repo } = requireRepo(flags);
  const mirror = path.resolve(requireFlag(flags, "mirror"));
  if (existsSync(mirror)) {
    throw new CliError(`Mirror already exists: ${mirror}`);
  }
  const url = gitUrl(owner, repo);
  if (flags["dry-run"]) {
    return responseEnvelope({
      provider: "gitcode",
      owner,
      repo,
      data: { mirror, url, initialized: false },
      extra: { dryRun: true },
    });
  }

  await mkdir(path.dirname(mirror), { recursive: true });
  await runGit(["clone", "--mirror", url, mirror]);
  return responseEnvelope({
    provider: "gitcode",
    owner,
    repo,
    data: { mirror, url, initialized: true },
  });
}

async function mirrorFetch(flags) {
  const mirror = path.resolve(requireFlag(flags, "mirror"));
  if (!existsSync(mirror)) {
    throw new CliError(`Mirror does not exist: ${mirror}`);
  }
  if (!flags["dry-run"]) {
    await runGit(["--git-dir", mirror, "fetch", "--prune", "origin"]);
  }
  return responseEnvelope({
    provider: "gitcode",
    data: { mirror, fetched: !flags["dry-run"] },
    extra: flags["dry-run"] ? { dryRun: true } : {},
  });
}

async function mirrorWorktreeAdd(flags) {
  const mirror = path.resolve(requireFlag(flags, "mirror"));
  const worktree = path.resolve(requireFlag(flags, "path"));
  const branch = requireFlag(flags, "branch");
  const startPoint = requireFlag(flags, "start-point");
  if (!existsSync(mirror)) {
    throw new CliError(`Mirror does not exist: ${mirror}`);
  }
  if (existsSync(worktree)) {
    throw new CliError(`Worktree path already exists: ${worktree}`);
  }
  if (worktree === mirror || worktree.startsWith(`${mirror}${path.sep}`)) {
    throw new CliError("Worktree path must be outside the bare mirror directory");
  }
  let resolvedStartPoint = startPoint;
  if (startPoint.startsWith("origin/")) {
    const mirrorBranch = startPoint.slice("origin/".length);
    await runGit(["--git-dir", mirror, "show-ref", "--verify", `refs/heads/${mirrorBranch}`]);
    resolvedStartPoint = mirrorBranch;
  }
  await runGit(["--git-dir", mirror, "rev-parse", "--verify", `${resolvedStartPoint}^{commit}`]);
  if (!flags["dry-run"]) {
    await runGit(["--git-dir", mirror, "worktree", "add", "-b", branch, worktree, resolvedStartPoint]);
  }
  return responseEnvelope({
    provider: "gitcode",
    data: {
      mirror,
      worktree,
      branch,
      startPoint,
      resolvedStartPoint,
      created: !flags["dry-run"],
    },
    extra: flags["dry-run"] ? { dryRun: true } : {},
  });
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/benyue-gitcode.mjs <command> [options]

Commands:
  repo show --owner <owner> --repo <repo>
  issue list --owner <owner> --repo <repo> [--state open|closed|all]
  issue create --owner <owner> --repo <repo> --title <title> --body-file <file> [--labels labels]
  issue comment --owner <owner> --repo <repo> --number <number> --body-file <file>
  mr list --owner <owner> --repo <repo> [--state open|closed|all] [--head branch] [--base branch]
  mr create --owner <owner> --repo <repo> --head <branch> --base <branch> --title <title> --body-file <file>
  mr comment --owner <owner> --repo <repo> --number <number> --body-file <file>
  branch check --owner <owner> --repo <repo> --branch <branch>
  mirror init --owner <owner> --repo <repo> --mirror <path>
  mirror fetch --mirror <path>
  mirror worktree add --mirror <path> --path <worktree> --branch <branch> --start-point <ref>

Common options:
  --output json|table       Output format; default is json.
  --dry-run                 Print the mutation payload or planned git operation without applying it.
  --allow-duplicate         Skip exact duplicate detection when creating issues or merge requests.
  --dedupe-key <key>        Skip an issue/MR comment when the marker already exists.
  --per-page <count>        Page size for list requests; default 50, maximum 100.

Authentication:
  GITCODE_TOKEN              API token and HTTPS Git askpass password.
  GITCODE_USE_SSH=1          Use SSH for Git operations instead of HTTPS.
  GITCODE_API_BASE           Optional API base; defaults to https://gitcode.com/api/v5.

Security:
  The CLI never prints GITCODE_TOKEN and never embeds it in a remote URL.
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  if (positional.length === 0 || flags.help) {
    printHelp();
    return;
  }

  const output = normalizeOutput(flags);
  const group = requirePositional(positional, 0, "command group");
  const action = requirePositional(positional, 1, "command");
  let result;

  if (group === "repo" && action === "show") result = await showRepo(flags);
  else if (group === "issue" && action === "list") result = await listIssues(flags);
  else if (group === "issue" && action === "create") result = await createIssue(flags);
  else if (group === "issue" && action === "comment") result = await commentIssue(flags);
  else if (group === "mr" && action === "list") result = await listMergeRequests(flags);
  else if (group === "mr" && action === "create") result = await createMergeRequest(flags);
  else if (group === "mr" && action === "comment") result = await commentMergeRequest(flags);
  else if (group === "branch" && action === "check") result = await checkBranch(flags);
  else if (group === "mirror" && action === "init") result = await mirrorInit(flags);
  else if (group === "mirror" && action === "fetch") result = await mirrorFetch(flags);
  else if (group === "mirror" && action === "worktree" && positional[2] === "add") result = await mirrorWorktreeAdd(flags);
  else {
    throw new CliError(`Unknown command: ${positional.join(" ")}`);
  }

  printResult(result, output);
}

try {
  await main();
} catch (error) {
  const { flags } = parseArgs(process.argv.slice(2));
  printError(error, flags);
  process.exitCode = 1;
}
