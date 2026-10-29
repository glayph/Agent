#!/usr/bin/env node
// Runs deploy/systemd/miki-healthcheck.sh with stand-in curl/systemctl and checks the restart rules:
// restart only after repeated failures, never while a young llama server reports "loading".
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miki-hc-"));
const bin = path.join(dir, "bin");
fs.mkdirSync(bin);
fs.mkdirSync(path.join(dir, "state"));
const write = (name, text) => { fs.writeFileSync(path.join(bin, name), text, { mode: 0o755 }); };
write("curl", `#!/bin/bash
args="$*"
if [[ "$args" == *"39200/health"* ]]; then [[ -f "$STUB_DIR/llama_loading" ]] && echo '{"status":"loading model"}'; exit 0; fi
[[ "$args" == *"39200/v1/models"* && -f "$STUB_DIR/llama_down" ]] && exit 22
[[ "$args" == *"18800/gateway/live"* && -f "$STUB_DIR/gw_down" ]] && exit 22
exit 0
`);
write("systemctl", `#!/bin/bash
if [[ "$1" == "show" ]]; then date -u -d "-\${STUB_AGE:-30} seconds" "+%a %Y-%m-%d %H:%M:%S UTC"; exit 0; fi
[[ "$1" == "is-active" ]] && exit 0
echo "$*" >> "$STUB_DIR/systemctl.log"
`);
write("logger", "#!/bin/bash\nexit 0\n");
write("flock", "#!/bin/bash\nexit 0\n");
const script = fs.readFileSync(path.join(root, "deploy", "systemd", "miki-healthcheck.sh"), "utf8")
  .replace(/^ENV_FILE=.*$/m, "ENV_FILE=/nonexistent").replace(/^LOCK_FILE=.*$/m, `LOCK_FILE=${dir}/lock`);
fs.writeFileSync(path.join(dir, "hc.sh"), script);
const env = { ...process.env, STUB_DIR: dir, MIKI_HEALTH_STATE_DIR: path.join(dir, "state"), PATH: `${bin}:${process.env.PATH}` };
const run = () => childProcess.spawnSync("bash", [path.join(dir, "hc.sh")], { env, stdio: "ignore" });
const restarts = () => (fs.existsSync(path.join(dir, "systemctl.log")) ? fs.readFileSync(path.join(dir, "systemctl.log"), "utf8").trim() : "");
const flag = (name, on) => (on ? fs.writeFileSync(path.join(dir, name), "1") : fs.rmSync(path.join(dir, name), { force: true }));
const expect = (actual, expected, what) => { if (actual !== expected) { console.error(`${what}: expected "${expected}", got "${actual}"`); process.exit(1); } };

flag("gw_down", true);
run(); run();
expect(restarts(), "", "two failures must not restart");
run();
expect(restarts(), "restart miki-gateway.service", "third failure restarts the gateway");
flag("gw_down", false); fs.rmSync(path.join(dir, "systemctl.log"), { force: true });
flag("llama_down", true); flag("llama_loading", true);
for (let i = 0; i < 4; i += 1) run();
expect(restarts(), "", "a loading llama server is not restarted");
flag("llama_loading", false);
for (let i = 0; i < 3; i += 1) run();
expect(restarts(), "restart miki-llama.service", "a dead llama server is restarted after three failures");
fs.rmSync(dir, { recursive: true, force: true });
console.log("[healthcheck-dryrun] passed");
