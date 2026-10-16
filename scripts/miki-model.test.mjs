import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manager = path.join(root, "scripts", "miki-model.mjs");
const hasOpenssl = spawnSync("openssl", ["version"]).status === 0;

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [manager, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

function runAsync(args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [manager, ...args],
      { cwd: root, encoding: "utf8", env: { ...process.env, ...extraEnv } },
      (error, stdout, stderr) => {
        resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr });
      },
    );
  });
}

function isolatedEnv(temp) {
  return {
    MIKI_RUNTIME_ROOT: path.join(temp, "runtime"),
    MIKI_MODEL_DIR: path.join(temp, "models"),
    MIKI_STATE_PATH: path.join(temp, "runtime", "data", "launcher-state.json"),
    MIKI_CONFIG_DIR: path.join(temp, "runtime", "config"),
  };
}

function ggufPayload(size = 2048) {
  return Buffer.concat([Buffer.from("GGUF", "ascii"), crypto.randomBytes(size)]);
}

test("lists a pinned catalog entry without network access", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-list-test-"));
  const result = run(["list"], { MIKI_MODEL_DIR: path.join(temp, "models") });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.ok(data.catalog.length >= 2);
  const lfm = data.catalog.find((entry) => entry.id === "lfm2.5-1.2b-instruct-q4_0");
  const gemma = data.catalog.find((entry) => entry.id === "gemma-4-E2B-it-Q4_0");
  assert.ok(lfm);
  assert.ok(gemma);
  for (const entry of [lfm, gemma]) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.installed, false);
  }
  fs.rmSync(temp, { recursive: true, force: true });
});

test("status uses isolated user paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const result = run(["status"], isolatedEnv(temp));
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.installed.length, 0);
  assert.equal(data.registered.length, 0);
  assert.equal(data.model_dir, path.join(temp, "models"));
  fs.rmSync(temp, { recursive: true, force: true });
});

test("rejects unknown bare names before any network request", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const result = run(["install", "https://example.invalid/model.gguf"], isolatedEnv(temp));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown model/);
  assert.equal(fs.existsSync(path.join(temp, "models")), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("rejects a --url value that is not a URL before any network request", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const result = run(["install", "--url", "not a url"], isolatedEnv(temp));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a valid URL/);
  assert.equal(fs.existsSync(path.join(temp, "models")), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("rejects a malformed --sha256 before any network request", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const result = run(
    ["install", "--url", "https://example.invalid/model.gguf", "--sha256", "not-a-digest"],
    isolatedEnv(temp),
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256/);
  assert.equal(fs.existsSync(path.join(temp, "models")), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("registers a GGUF on disk in place and reports it in status", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const env = isolatedEnv(temp);
  const modelFile = path.join(temp, "external", "My-Local.gguf");
  fs.mkdirSync(path.dirname(modelFile), { recursive: true });
  fs.writeFileSync(modelFile, ggufPayload(256));

  const result = run(["install", "--path", modelFile, "--name", "my-local-model"], env);
  assert.equal(result.status, 0, result.stderr);
  const installed = JSON.parse(result.stdout);
  assert.equal(installed.status, "installed");
  assert.equal(installed.model, "my-local-model");
  assert.equal(installed.path, modelFile);
  assert.equal(installed.checksum_verified, false);

  const state = JSON.parse(fs.readFileSync(env.MIKI_STATE_PATH, "utf8"));
  const record = state.models.find((entry) => entry.model_name === "my-local-model");
  assert.ok(record);
  assert.equal(record.local.model_path, modelFile);
  assert.deepEqual(record.local.allowed_model_dirs, [path.dirname(modelFile)]);
  assert.equal(fs.existsSync(path.join(temp, "models", "my-local-model.gguf")), false);

  const envFile = fs.readFileSync(path.join(env.MIKI_CONFIG_DIR, ".env"), "utf8");
  assert.match(envFile, /^MIKI_MODEL=llama\.cpp\/my-local-model$/m);

  const status = JSON.parse(run(["status"], env).stdout);
  assert.ok(status.registered.some((entry) => entry.model_name === "my-local-model" && entry.present));

  const removed = run(["remove", "my-local-model"], env);
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(fs.existsSync(modelFile), true, "user file must not be deleted");
  const afterRemove = JSON.parse(fs.readFileSync(env.MIKI_STATE_PATH, "utf8"));
  assert.equal(afterRemove.models.some((entry) => entry.model_name === "my-local-model"), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("rejects a local file that lacks the GGUF header", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const env = isolatedEnv(temp);
  const fake = path.join(temp, "fake.gguf");
  fs.writeFileSync(fake, "this is not a model");
  const result = run(["install", "--path", fake], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing GGUF header/);
  assert.equal(fs.existsSync(env.MIKI_STATE_PATH), false);
  fs.rmSync(temp, { recursive: true, force: true });
});

test("refuses to install a custom model under a catalog name", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
  const env = isolatedEnv(temp);
  const modelFile = path.join(temp, "external", "model.gguf");
  fs.mkdirSync(path.dirname(modelFile), { recursive: true });
  fs.writeFileSync(modelFile, ggufPayload(64));
  const result = run(["install", "--path", modelFile, "--name", "gemma-4-e2b"], env);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /catalog model name/);
  fs.rmSync(temp, { recursive: true, force: true });
});

async function startGgufServer(temp, payload) {
  const certPath = path.join(temp, "cert.pem");
  const keyPath = path.join(temp, "key.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  const server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (request, response) => {
      if (request.url.startsWith("/models/tiny-test.gguf")) {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": payload.length,
        });
        response.end(payload);
        return;
      }
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    certPath,
    url: `https://127.0.0.1:${server.address().port}/models/tiny-test.gguf?download=true`,
  };
}

test(
  "downloads a user-named HTTPS GGUF, verifies SHA-256, and registers it",
  { skip: !hasOpenssl },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
    const env = isolatedEnv(temp);
    const payload = ggufPayload();
    const digest = crypto.createHash("sha256").update(payload).digest("hex");
    const { server, certPath, url } = await startGgufServer(temp, payload);
    try {
      const result = await runAsync(
        ["install", "--url", url, "--sha256", digest],
        { ...env, NODE_EXTRA_CA_CERTS: certPath },
      );
      assert.equal(result.code, 0, result.stderr);
      const installed = JSON.parse(result.stdout);
      assert.equal(installed.model, "tiny-test");
      assert.equal(installed.sha256, digest);
      assert.equal(installed.checksum_verified, true);
      assert.equal(installed.source, url.split("?")[0], "query strings must not be echoed");

      const file = path.join(temp, "models", "tiny-test.gguf");
      assert.ok(fs.readFileSync(file).equals(payload));
      const state = JSON.parse(fs.readFileSync(env.MIKI_STATE_PATH, "utf8"));
      const record = state.models.find((entry) => entry.model_name === "tiny-test");
      assert.ok(record);
      assert.equal(record.local.model_path, file);
    } finally {
      server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "discards a download whose SHA-256 does not match the supplied digest",
  { skip: !hasOpenssl },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
    const env = isolatedEnv(temp);
    const payload = ggufPayload();
    const { server, certPath, url } = await startGgufServer(temp, payload);
    try {
      const result = await runAsync(
        ["install", "--url", url, "--sha256", "0".repeat(64)],
        { ...env, NODE_EXTRA_CA_CERTS: certPath },
      );
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /SHA-256 mismatch/);
      assert.equal(fs.existsSync(path.join(temp, "models", "tiny-test.gguf")), false);
      assert.equal(fs.existsSync(env.MIKI_STATE_PATH), false);
    } finally {
      server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);

function createSelfSignedCert(temp) {
  const certPath = path.join(temp, "hub-cert.pem");
  const keyPath = path.join(temp, "hub-key.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes",
      "-keyout", keyPath, "-out", certPath, "-days", "1",
      "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  return { certPath, keyPath };
}

// Serves a minimal Hugging Face-compatible hub: one gated repo (must never be
// inspected), one public repo with a projector file and two quantizations.
async function startHubFixture(temp, payloads) {
  const { certPath, keyPath } = createSelfSignedCert(temp);
  const hits = [];
  const server = https.createServer(
    { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) },
    (request, response) => {
      const url = new URL(request.url, "https://127.0.0.1");
      hits.push(`${request.method} ${url.pathname}${url.search}`);
      const sendJson = (value) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (url.pathname === "/api/models") {
        sendJson([
          { id: "acme/gated-chat-GGUF", gated: "manual", downloads: 900 },
          { id: "acme/tiny-chat-GGUF", gated: false, downloads: 100 },
        ]);
        return;
      }
      if (url.pathname === "/api/models/acme/tiny-chat-GGUF") {
        sendJson({
          id: "acme/tiny-chat-GGUF",
          siblings: [
            { rfilename: "README.md" },
            { rfilename: "mmproj-tiny-chat.gguf", size: 10 },
            {
              rfilename: "tiny-chat.Q8_0.gguf",
              size: payloads.q8.length,
              lfs: { sha256: payloads.q8Sha, size: payloads.q8.length },
            },
            {
              rfilename: "tiny-chat.Q4_K_M.gguf",
              size: payloads.q4.length,
              lfs: { sha256: payloads.q4Sha, size: payloads.q4.length },
            },
          ],
        });
        return;
      }
      if (url.pathname === "/acme/tiny-chat-GGUF/resolve/main/tiny-chat.Q4_K_M.gguf") {
        response.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": payloads.q4.length,
        });
        response.end(payloads.q4);
        return;
      }
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, certPath, endpoint: `https://127.0.0.1:${server.address().port}`, hits };
}

function hubPayloads() {
  const q4 = ggufPayload(4096);
  const q8 = ggufPayload(8192);
  return {
    q4,
    q8,
    q4Sha: crypto.createHash("sha256").update(q4).digest("hex"),
    q8Sha: crypto.createHash("sha256").update(q8).digest("hex"),
  };
}

test(
  "auto picks a public GGUF chat model, skips gated repos and projectors, and registers it",
  { skip: !hasOpenssl },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
    const env = isolatedEnv(temp);
    const payloads = hubPayloads();
    const hub = await startHubFixture(temp, payloads);
    try {
      const result = await runAsync(["auto", "--query", "tiny"], {
        ...env,
        HF_ENDPOINT: hub.endpoint,
        NODE_EXTRA_CA_CERTS: hub.certPath,
      });
      assert.equal(result.code, 0, result.stderr);
      const installed = JSON.parse(result.stdout);
      assert.equal(installed.status, "installed");
      assert.equal(installed.selected, "acme/tiny-chat-GGUF");
      assert.equal(installed.file, "tiny-chat.Q4_K_M.gguf");
      assert.equal(installed.sha256, payloads.q4Sha);
      assert.equal(installed.checksum_verified, true);

      const file = path.join(temp, "models", `${installed.model}.gguf`);
      assert.ok(fs.readFileSync(file).equals(payloads.q4));
      const state = JSON.parse(fs.readFileSync(env.MIKI_STATE_PATH, "utf8"));
      assert.ok(state.models.some((entry) => entry.model_name === installed.model));
      const envFile = fs.readFileSync(path.join(env.MIKI_CONFIG_DIR, ".env"), "utf8");
      assert.match(envFile, new RegExp(`^MIKI_MODEL=llama\\.cpp/${installed.model.replace(/[.]/g, "\\.")}$`, "m"));
      assert.ok(hub.hits.some((hit) => hit.includes("search=tiny")));
    } finally {
      hub.server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "auto --dry-run ranks candidates without downloading anything",
  { skip: !hasOpenssl },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
    const env = isolatedEnv(temp);
    const hub = await startHubFixture(temp, hubPayloads());
    try {
      const result = await runAsync(["auto", "--dry-run"], {
        ...env,
        HF_ENDPOINT: hub.endpoint,
        NODE_EXTRA_CA_CERTS: hub.certPath,
      });
      assert.equal(result.code, 0, result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.status, "dry-run");
      assert.equal(data.candidates[0].filename, "tiny-chat.Q4_K_M.gguf");
      assert.equal(data.candidates.some((candidate) => candidate.filename.includes("mmproj")), false);
      assert.equal(hub.hits.some((hit) => hit.includes("/resolve/")), false);
      assert.equal(fs.existsSync(path.join(temp, "models")), false);
    } finally {
      hub.server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);

test(
  "auto fails clearly when no candidate fits --max-bytes",
  { skip: !hasOpenssl },
  async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-model-test-"));
    const env = isolatedEnv(temp);
    const hub = await startHubFixture(temp, hubPayloads());
    try {
      const result = await runAsync(["auto", "--max-bytes", "10"], {
        ...env,
        HF_ENDPOINT: hub.endpoint,
        NODE_EXTRA_CA_CERTS: hub.certPath,
      });
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, /No GGUF chat model/);
      assert.equal(fs.existsSync(env.MIKI_STATE_PATH), false);
    } finally {
      hub.server.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  },
);
