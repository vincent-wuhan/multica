import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { test } from "node:test";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

const cliPath = new URL("./benyue-gitcode.mjs", import.meta.url).pathname;
const token = "test-gitcode-token";

function startApiServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}/api/v5` });
    });
  });
}

async function runCli(args, env = {}) {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [cliPath, ...args], {
    env: {
      ...childEnv,
      GITCODE_TOKEN: token,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return {
    status,
    stdout,
    stderr,
    json: () => JSON.parse(stdout),
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test("repo show returns a normalized JSON envelope", async () => {
  const requests = [];
  const { server, baseUrl } = await startApiServer((request, response) => {
    requests.push({ method: request.method, url: request.url, token: request.headers["private-token"] });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: "reviewpilot", full_name: "glorius/reviewpilot" }));
  });

  try {
    const result = await runCli(["repo", "show", "--owner", "glorius", "--repo", "reviewpilot"], {
      GITCODE_API_BASE: baseUrl,
    });
    assert.equal(result.status, 0);
    const payload = result.json();
    assert.deepEqual(requests, [
      { method: "GET", url: "/api/v5/repos/glorius/reviewpilot", token },
    ]);
    assert.equal(payload.success, true);
    assert.equal(payload.provider, "gitcode");
    assert.equal(payload.owner, "glorius");
    assert.equal(payload.repo, "reviewpilot");
    assert.equal(payload.data.full_name, "glorius/reviewpilot");
  } finally {
    await closeServer(server);
  }
});

test("issue list follows pagination until a short page", async () => {
  let calls = 0;
  const requests = [];
  const issue = (number) => ({ number: String(number), title: `Issue ${number}`, state: "open" });
  const { server, baseUrl } = await startApiServer((request, response) => {
    calls += 1;
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({
      pathname: url.pathname,
      state: url.searchParams.get("state"),
      page: url.searchParams.get("page"),
      perPage: url.searchParams.get("per_page"),
    });
    const start = (calls - 1) * 2 + 1;
    const issues = calls === 2 ? [issue(start)] : [issue(start), issue(start + 1)];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(issues));
  });

  try {
    const result = await runCli(
      ["issue", "list", "--owner", "glorius", "--repo", "reviewpilot", "--state", "open", "--per-page", "2"],
      { GITCODE_API_BASE: baseUrl },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(
      result.json().data.map((issue) => issue.number),
      ["1", "2", "3"],
    );
    assert.deepEqual(requests, [
      { pathname: "/api/v5/repos/glorius/reviewpilot/issues", state: "open", page: "1", perPage: "2" },
      { pathname: "/api/v5/repos/glorius/reviewpilot/issues", state: "open", page: "2", perPage: "2" },
    ]);
    assert.equal(calls, 2);
  } finally {
    await closeServer(server);
  }
});

test("issue create is idempotent for an exact open title", async () => {
  let mutations = 0;
  const requests = [];
  const { server, baseUrl } = await startApiServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    requests.push({
      method: request.method,
      pathname: url.pathname,
      search: url.searchParams.get("search"),
      perPage: url.searchParams.get("per_page"),
    });
    if (request.method === "GET") {
      assert.equal(url.pathname, "/api/v5/repos/glorius/reviewpilot/issues");
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{ number: "7", title: "Duplicate issue", state: "open" }]));
      return;
    }

    mutations += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ number: "8", title: "Duplicate issue", state: "open" }));
  });

  try {
    const result = await runCli(
      [
        "issue",
        "create",
        "--owner",
        "glorius",
        "--repo",
        "reviewpilot",
        "--title",
        "Duplicate issue",
        "--body-file",
        cliPath,
      ],
      { GITCODE_API_BASE: baseUrl },
    );
    assert.equal(result.status, 0);
    const payload = result.json();
    assert.deepEqual(requests, [
      {
        method: "GET",
        pathname: "/api/v5/repos/glorius/reviewpilot/issues",
        search: "Duplicate issue",
        perPage: "100",
      },
    ]);
    assert.equal(payload.duplicate, true);
    assert.equal(payload.data.number, "7");
    assert.equal(mutations, 0);
  } finally {
    await closeServer(server);
  }
});

test("comment dedupe markers are injected by the CLI", async () => {
  const result = await runCli([
    "issue",
    "comment",
    "--owner",
    "glorius",
    "--repo",
    "reviewpilot",
    "--number",
    "7",
    "--body-file",
    cliPath,
    "--dedupe-key",
    "beny-43",
    "--dry-run",
  ]);

  assert.equal(result.status, 0);
  assert.match(result.json().data.body, /^<!-- benyue-gitcode-dedupe:beny-43 -->\n\n/);
});

test("issue comments use the GitCode body field and validate numbers", async () => {
  let postedBody = "";
  const { server, baseUrl } = await startApiServer((request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end("[]");
      return;
    }
    request.on("data", (chunk) => {
      postedBody += chunk;
    });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ number: 7, body: "posted" }));
    });
  });

  try {
    const result = await runCli([
      "issue",
      "comment",
      "--owner",
      "glorius",
      "--repo",
      "reviewpilot",
      "--number",
      "7",
      "--body-file",
      cliPath,
      "--dedupe-key",
      "beny-44",
    ], { GITCODE_API_BASE: baseUrl });
    assert.equal(result.status, 0);
    assert.match(postedBody, /(^|&)body=/);
    assert.doesNotMatch(postedBody, /(^|&)content=/);

    const invalid = await runCli([
      "issue",
      "comment",
      "--owner",
      "glorius",
      "--repo",
      "reviewpilot",
      "--number",
      "../../other/repo",
      "--body-file",
      cliPath,
      "--dry-run",
    ]);
    assert.equal(invalid.status, 1);
    assert.equal(invalid.json().error, "--number must be a positive integer");
  } finally {
    await closeServer(server);
  }
});

test("issue comments skip mutation when an existing marker is found", async () => {
  let mutations = 0;
  const { server, baseUrl } = await startApiServer((request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{
        number: 11,
        body: "<!-- benyue-gitcode-dedupe:beny-44 -->\n\nexisting",
      }]));
      return;
    }
    mutations += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ number: 11, body: "posted" }));
  });

  try {
    const result = await runCli([
      "issue",
      "comment",
      "--owner",
      "glorius",
      "--repo",
      "reviewpilot",
      "--number",
      "11",
      "--body-file",
      cliPath,
      "--dedupe-key",
      "beny-44",
    ], { GITCODE_API_BASE: baseUrl });
    assert.equal(result.status, 0);
    assert.equal(result.json().duplicate, true);
    assert.equal(result.json().data.body, "<!-- benyue-gitcode-dedupe:beny-44 -->\n\nexisting");
    assert.equal(mutations, 0);
  } finally {
    await closeServer(server);
  }
});

test("merge request creation supports explicit duplicate override", async () => {
  let mutations = 0;
  const { server, baseUrl } = await startApiServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify([{
        number: 16,
        title: "Existing MR",
        head: { ref: "codex/example" },
        base: { ref: "main" },
      }]));
      return;
    }
    mutations += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ number: 17, title: "Replacement MR" }));
  });

  try {
    const result = await runCli([
      "mr",
      "create",
      "--owner",
      "glorius",
      "--repo",
      "reviewpilot",
      "--head",
      "codex/example",
      "--base",
      "main",
      "--title",
      "Replacement MR",
      "--body-file",
      cliPath,
      "--allow-duplicate",
    ], { GITCODE_API_BASE: baseUrl });
    assert.equal(result.status, 0);
    assert.equal(mutations, 1);
    assert.equal(result.json().data.number, 17);
  } finally {
    await closeServer(server);
  }
});

test("branch names are URL encoded without double slash loss", async () => {
  const requests = [];
  const { server, baseUrl } = await startApiServer((request, response) => {
    requests.push(request.url);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ name: "sit/20260820" }));
  });

  try {
    const result = await runCli(
      ["branch", "check", "--owner", "glorius", "--repo", "reviewpilot", "--branch", "sit/20260820"],
      { GITCODE_API_BASE: baseUrl },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(requests, ["/api/v5/repos/glorius/reviewpilot/branches/sit%2F20260820"]);
    assert.equal(result.json().data.name, "sit/20260820");
  } finally {
    await closeServer(server);
  }
});

test("nested API error payloads are recursively redacted", async () => {
  const { server, baseUrl } = await startApiServer((request, response) => {
    response.statusCode = 500;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      error_message: `oauth2:${token}@ upstream failed private_token=${token}`,
      response: {
        nested: JSON.stringify({ refresh_token: token }),
      },
    }));
  });

  try {
    const result = await runCli(["repo", "show", "--owner", "glorius", "--repo", "reviewpilot"], {
      GITCODE_API_BASE: baseUrl,
    });
    assert.equal(result.status, 1);
    const payload = result.json();
    assert.equal(payload.success, false);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!JSON.stringify(payload.details).includes(token));
    assert.ok(JSON.stringify(payload.details).includes("[REDACTED]"));
    assert.match(payload.error, /oauth2:\[REDACTED\]@/);
    assert.match(payload.error, /private_token=\[REDACTED\]/);
  } finally {
    await closeServer(server);
  }
});

test("mirror init dry run does not create the mirror or leak the token", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "benyue-gitcode-test-"));
  const mirror = path.join(directory, "nested", "mirror.git");
  const result = await runCli([
    "mirror",
    "init",
    "--owner",
    "glorius",
    "--repo",
    "reviewpilot",
    "--mirror",
    mirror,
    "--dry-run",
  ]);

  try {
    assert.equal(result.status, 0);
    const payload = result.json();
    assert.equal(payload.dryRun, true);
    assert.equal(payload.data.initialized, false);
    assert.equal(payload.data.url, "https://gitcode.com/glorius/reviewpilot.git");
    assert.equal(existsSync(path.dirname(mirror)), false);
    assert.ok(!result.stdout.includes(token));
    assert.ok(!result.stderr.includes(token));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
