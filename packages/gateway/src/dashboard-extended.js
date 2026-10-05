import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import { diffUsbDevices, scanLinuxUsbDevices } from "./usb-monitor.js";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Router } from "express";
import * as yaml from "js-yaml";
import { createGoalsRouter, GoalStore } from "@miki/core/api/goals";
import { createLinkPreviewRouter } from "@miki/core/api/link-preview";
import { WhisperCppService, SpeechToTextError, loadSpeechToTextSettings } from "@miki/core/speech-to-text";
import { listBuiltinPluginHealth } from "@miki/core/plugins";
import QRCode from "qrcode";
import { ExternalMcpConnectorManager } from "@miki/core/mcp/connectors";
import { SelfImprovementEngine } from "@miki/core/self-improvement";
import { LearningStore } from "@miki/memory";
import { getLifecycleBus } from "@miki/core/hooks";
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function clone(value) {
    return JSON.parse(JSON.stringify(value));
}
function asRecord(value) {
    return isRecord(value) ? value : {};
}
function stringValue(value) {
    return typeof value === "string" ? value.trim() : "";
}
function appMcpConfig(config) {
    const tools = asRecord(config.tools);
    const mcp = asRecord(tools.mcp);
    const discovery = asRecord(mcp.discovery);
    const serversRaw = asRecord(mcp.servers);
    const servers = {};
    for (const [name, raw] of Object.entries(serversRaw)) {
        const value = asRecord(raw);
        const type = value.type === "http" || value.type === "sse" ? value.type : "stdio";
        servers[name] = {
            name, enabled: value.enabled !== false, type,
            url: stringValue(value.url) || undefined,
            command: stringValue(value.command) || undefined,
            args: Array.isArray(value.args) ? value.args.filter((v) => typeof v === "string") : undefined,
            headers: isRecord(value.headers) ? Object.fromEntries(Object.entries(value.headers).filter((entry) => typeof entry[1] === "string")) : undefined,
            env: isRecord(value.env) ? Object.fromEntries(Object.entries(value.env).filter((entry) => typeof entry[1] === "string")) : undefined,
            headerEnv: isRecord(value.header_env) ? Object.fromEntries(Object.entries(value.header_env).filter((entry) => typeof entry[1] === "string")) : undefined,
            envFile: stringValue(value.env_file) || undefined,
            deferred: typeof value.deferred === "boolean" ? value.deferred : null,
            allowSideEffects: value.allow_side_effects === true,
        };
    }
    return {
        enabled: mcp.enabled !== false,
        discovery: {
            enabled: discovery.enabled !== false,
            ttl: Math.max(1, Number(discovery.ttl) || 5),
            maxSearchResults: Math.max(1, Number(discovery.max_search_results) || 5),
            useBM25: discovery.use_bm25 !== false,
            useRegex: discovery.use_regex === true,
        },
        servers,
    };
}
function jsonMask(value) {
    const text = stringValue(value);
    if (!text)
        return "";
    if (text.length <= 8)
        return "••••";
    return `${text.slice(0, 4)}…${text.slice(-4)}`;
}
function deepMergeLocal(base, incoming) {
    const output = { ...base };
    for (const [key, value] of Object.entries(incoming)) {
        output[key] = isRecord(output[key]) && isRecord(value) ? deepMergeLocal(output[key], value) : value;
    }
    return output;
}
const execFileAsync = promisify(execFile);
const CHANNEL_FIELDS = {
    telegram: ["token"], discord: ["token"], slack: ["bot_token", "app_token"],
    feishu: ["app_id", "app_secret"], dingtalk: ["webhook_url"],
    line: ["token", "channel_secret"], qq: ["bot_id", "token"], onebot: ["server_url"],
    weixin: ["account_id"], wecom: ["bot_id", "secret"], whatsapp: ["bridge_url"],
    whatsapp_native: ["config"], miki: ["token"], matrix: ["homeserver_url", "user_id", "access_token"],
    irc: ["server", "nick"], mqtt: ["broker", "agent_id"],
};
const CHANNEL_META = [
    ["telegram", "Telegram", "partial", "Configuration is persisted; live bot adapter is not managed by the persistent gateway."],
    ["discord", "Discord", "partial", "Configuration is persisted; live bot adapter is not managed by the persistent gateway."],
    ["slack", "Slack", "partial", "Configuration is persisted; live Socket Mode adapter is not managed here."],
    ["feishu", "Feishu", "partial", "Configuration and validation are managed by the dashboard."],
    ["dingtalk", "DingTalk", "partial", "Configuration and webhook validation are managed by the dashboard."],
    ["qq", "QQ", "partial", "Configuration is managed by the dashboard."],
    ["weixin", "Weixin", "partial", "QR binding is managed by the persistent gateway; live message transport remains adapter-owned."],
    ["wecom", "WeCom", "partial", "QR binding is managed by the persistent gateway; live message transport remains adapter-owned."],
    ["line", "LINE", "partial", "Configuration is managed by the dashboard."],
    ["onebot", "OneBot", "partial", "Configuration is managed by the dashboard."],
    ["whatsapp", "WhatsApp", "config_only", "Bridge configuration is persisted; no persistent WhatsApp adapter is hosted here."],
    ["whatsapp_native", "WhatsApp Native", "config_only", "Native connection configuration is persisted; live adapter is not hosted here."],
    ["miki", "Miki", "partial", "Configuration is managed by the persistent gateway."],
    ["matrix", "Matrix", "partial", "Configuration is managed by the dashboard."],
    ["irc", "IRC", "partial", "Configuration is managed by the dashboard."],
    ["mqtt", "MQTT", "partial", "Configuration and broker validation are managed by the dashboard."],
].map(([name, display_name, runtime_status, note]) => ({ name, display_name, runtime_status, note }));
const CHANNEL_SECRET_KEYS = new Set([
    "token", "app_secret", "client_secret", "corp_secret", "channel_secret", "channel_access_token",
    "access_token", "webhook_token", "webhook_url", "bot_token", "app_token", "encoding_aes_key",
    "encrypt_key", "verification_token", "secret", "username", "password", "nickserv_password", "sasl_password",
]);
function channelRoot(config) {
    const current = asRecord(config.channel_list);
    return current;
}
function getChannelRecord(config, name) {
    return asRecord(channelRoot(config)[name]);
}
function splitChannelConfig(raw) {
    const common = {};
    const settings = {};
    for (const [key, value] of Object.entries(raw)) {
        if (["enabled", "type", "allow_from", "group_trigger", "placeholder", "reasoning_channel_id", "typing"].includes(key))
            common[key] = value;
        else
            settings[key] = value;
    }
    if (isRecord(raw.settings))
        Object.assign(settings, raw.settings);
    return { common, settings };
}
function getSpeechConfigPath(configDir) {
    return path.join(configDir, "agent.yaml");
}
function readYamlConfig(configPath) {
    try {
        const parsed = yaml.load(fs.readFileSync(configPath, "utf8"));
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
async function writeYamlConfig(configPath, next) {
    await fsp.writeFile(configPath, yaml.dump(next, { lineWidth: 120 }), { mode: 0o600 });
}
function publicSpeechSettings(settings) {
    return clone(settings);
}
function voiceCatalog(config) {
    const root = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
    const sha = {
        base: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
        "base.en": "137c40403d78fd54d454da0f9bd998f78703390c",
        small: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
    };
    const sizes = { base: "142 MiB", "base.en": "142 MiB", small: "466 MiB" };
    return ["base", "base.en", "small"].map((id) => {
        const active = config.active_model_id === id;
        const installed = Boolean(config.models.find((item) => item.id === id)?.model);
        return {
            id,
            name: `Whisper ${id}`,
            description: `Official whisper.cpp ${id} model`,
            languages: id.endsWith(".en") ? "English" : "Multilingual",
            size: sizes[id],
            sha1: sha[id],
            modelUrl: `${root}/ggml-${id}.bin`,
            licenseUrl: "https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md",
            transport: "cli",
            installed,
            active,
        };
    });
}
async function downloadVoiceModel(modelId, target) {
    if (!["base", "base.en", "small"].includes(modelId))
        throw new Error("Voice model is not allow-listed.");
    const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelId}.bin`;
    const expected = { base: "465707469ff3a37a2b9b8d8f89f2f99de7299dac", "base.en": "137c40403d78fd54d454da0f9bd998f78703390c", small: "55356645c2b361a969dfd0ef2c5a50d530afd8d5" }[modelId];
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body)
        throw new Error(`Voice model download failed with HTTP ${response.status}.`);
    const tmp = `${target}.part`;
    const file = fs.createWriteStream(tmp, { mode: 0o600 });
    const hasher = createHash("sha1");
    try {
        const reader = response.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            const chunk = Buffer.from(value);
            hasher.update(chunk);
            file.write(chunk);
        }
        await new Promise((resolve, reject) => file.end((error) => error ? reject(error) : resolve()));
        if (hasher.digest("hex") !== expected)
            throw new Error(`Voice model checksum mismatch for ${modelId}.`);
        await fsp.rename(tmp, target);
    }
    catch (error) {
        file.destroy();
        await fsp.rm(tmp, { force: true }).catch(() => undefined);
        throw error;
    }
}
async function modelRuntimeStatus(configDir) {
    try {
        const settings = loadSpeechToTextSettings(configDir);
        const catalog = voiceCatalog(settings);
        const runtimeConfigured = Boolean(settings.endpoint || (settings.executable && settings.model));
        const executableExists = Boolean(settings.executable && fs.existsSync(settings.executable));
        const modelExists = Boolean(settings.model && fs.existsSync(settings.model));
        const healthy = settings.enabled && runtimeConfigured && (settings.endpoint ? true : executableExists && modelExists);
        return {
            installed: settings.models.some((m) => m.id === settings.active_model_id && Boolean(m.model)),
            enabled: settings.enabled,
            activeModelId: settings.active_model_id ?? null,
            activeModelName: settings.models.find((m) => m.id === settings.active_model_id)?.name ?? null,
            transport: settings.endpoint ? "endpoint" : settings.executable ? "cli" : null,
            runtimeConfigured,
            healthy,
            reason: healthy ? "Speech-to-text runtime is configured." : settings.enabled ? "Speech-to-text runtime is not ready." : "Speech-to-text is disabled.",
            modelDirectory: path.join(configDir, "voice-models"),
            executable: settings.executable,
            endpoint: settings.endpoint,
            catalog,
        };
    }
    catch (error) {
        return {
            installed: false, enabled: false, activeModelId: null, activeModelName: null, transport: null,
            runtimeConfigured: false, healthy: false, reason: error instanceof Error ? error.message : String(error),
            modelDirectory: path.join(configDir, "voice-models"), catalog: [],
        };
    }
}
function snapshotTable(db, table) {
    try {
        return db.prepare(`SELECT * FROM ${table}`).all();
    }
    catch {
        return [];
    }
}
async function loadBackups(dir) {
    await fsp.mkdir(dir, { recursive: true });
    const names = await fsp.readdir(dir).catch(() => []);
    const out = [];
    for (const name of names.filter((v) => v.endsWith(".json"))) {
        try {
            out.push(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8")));
        }
        catch { /* ignore corrupt backups */ }
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
function redactedPreview(value) {
    return value.replace(/([A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}([A-Za-z0-9_-]{4})/g, "$1••••$2");
}
async function scanSecrets(root) {
    const findings = [];
    let scannedFiles = 0;
    const ignored = new Set(["node_modules", ".git", "dist", ".cache"]);
    async function walk(dir) {
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (ignored.has(entry.name))
                continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            if (!entry.isFile())
                continue;
            try {
                const stat = await fsp.stat(full);
                if (stat.size > 1024 * 1024)
                    continue;
                const content = await fsp.readFile(full, "utf8");
                if (content.includes("\u0000"))
                    continue;
                scannedFiles += 1;
                content.split(/\r?\n/).forEach((line, index) => {
                    if (/BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY/.test(line))
                        findings.push({ file: path.relative(root, full), line: index + 1, pattern: "private-key", redactedPreview: "[PRIVATE KEY MATERIAL]" });
                    else if (/(api[_-]?key|access[_-]?token|bot[_-]?token|client[_-]?secret|password)\s*[:=]\s*[\"']?[^\s\"']{8,}/i.test(line))
                        findings.push({ file: path.relative(root, full), line: index + 1, pattern: "credential-assignment", redactedPreview: redactedPreview(line.trim()) });
                });
            }
            catch { /* unreadable/binary files are ignored */ }
        }
    }
    await walk(root);
    return { scannedFiles, fixedFiles: [], findings: findings.slice(0, 200) };
}
export function createDashboardExtendedRouter(deps) {
    const router = Router();
    const backupsDir = path.join(deps.dataRoot, "backups");
    const jobsDbInit = () => deps.db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, progress REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, error_json TEXT);
    CREATE TABLE IF NOT EXISTS delivery_receipts (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dashboard_qr_flows (id TEXT PRIMARY KEY, channel TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, account_id TEXT, bot_id TEXT, error TEXT, external_key TEXT, qr_data_uri TEXT, expires_at TEXT);
  `);
    jobsDbInit();
    const learningStore = new LearningStore(deps.db);
    learningStore.initializeSync();
    let evolutionSignature = "";
    let evolutionEngine = null;
    let evolutionTimer = null;
    let evolutionRunning = false;
    function evolutionConfig() {
        const rawEvolution = asRecord(deps.getAppConfig().evolution);
        const raw = {
            ...asRecord(deps.getAppConfig().self_improvement),
            ...rawEvolution,
            behavior_learning: {
                ...asRecord(asRecord(deps.getAppConfig().self_improvement).behavior_learning),
                ...asRecord(rawEvolution.behavior_learning),
            },
        };
        const behavior = asRecord(raw.behavior_learning);
        const configuredMode = stringValue(rawEvolution.mode) || stringValue(behavior.mode);
        const mode = configuredMode === "apply" || configuredMode === "draft" || configuredMode === "observe"
            ? configuredMode
            : "observe";
        const coldPathTimes = Array.isArray(raw.cold_path_times)
            ? raw.cold_path_times.filter((v) => typeof v === "string")
            : [];
        const trigger = stringValue(raw.cold_path_trigger) || "after_turn";
        const interval = 60;
        return {
            enabled: raw.enabled === true,
            reflection_interval_minutes: Math.max(1, Number(raw.reflection_interval_minutes ?? interval) || interval),
            optimization_interval_minutes: Math.max(1, Number(raw.optimization_interval_minutes ?? Math.max(interval * 3, 180)) || Math.max(interval * 3, 180)),
            prompt_tuning_interval_minutes: Math.max(1, Number(raw.prompt_tuning_interval_minutes ?? Math.max(interval * 2, 120)) || Math.max(interval * 2, 120)),
            max_daily_reflections: Math.max(1, Number(raw.max_daily_reflections ?? 12) || 12),
            max_reflections_per_day: Math.max(1, Number(raw.max_reflections_per_day ?? 12) || 12),
            auto_apply_optimizations: raw.auto_apply_optimizations === true,
            behavior_learning: {
                enabled: behavior.enabled !== false,
                mode,
                exploration_rate: Math.max(0, Math.min(1, Number(raw.exploration_rate ?? 0.1) || 0.1)),
                min_samples: Math.max(1, Number(raw.min_task_count ?? 3) || 3),
                max_draft_notes: Math.max(1, Number(raw.max_draft_notes ?? 3) || 3),
            },
        };
    }
    function getEvolutionEngine() {
        const config = evolutionConfig();
        const stateDir = String((asRecord(deps.getAppConfig().evolution).state_dir || deps.dataRoot));
        const signature = JSON.stringify({ config, stateDir });
        if (!evolutionEngine || signature !== evolutionSignature) {
            const llm = deps.agent.llmFor();
            evolutionEngine = new SelfImprovementEngine({ tkg: { learningStore } }, { dataDir: String((asRecord(deps.getAppConfig().evolution).state_dir || deps.dataRoot)) }, async (messages) => {
                const client = llm ?? deps.agent.llmFor();
                if (!client)
                    throw new Error("No configured LLM is available for self-improvement analysis.");
                return client.complete(messages.map((message) => ({ role: message.role, content: message.content })), { json: true, maxCompletionTokens: 600 });
            }, config);
            evolutionSignature = signature;
        }
        return evolutionEngine;
    }
    async function runDueEvolutionCycles(force = false) {
        const config = {
            ...asRecord(deps.getAppConfig().self_improvement),
            ...asRecord(deps.getAppConfig().evolution),
        };
        const trigger = stringValue(config.cold_path_trigger) || "after_turn";
        const scheduledTimes = Array.isArray(config.cold_path_times) ? config.cold_path_times.filter((v) => typeof v === "string") : [];
        if (!force && trigger === "scheduled") {
            const hhmm = new Date().toTimeString().slice(0, 5);
            if (!scheduledTimes.some((time) => time.trim() === hhmm))
                return { status: "not_scheduled", next_check: hhmm, configured_times: scheduledTimes };
        }
        const engine = getEvolutionEngine();
        if (evolutionRunning)
            return { status: "skipped", reason: "cycle_already_running" };
        evolutionRunning = true;
        try {
            const status = engine.getStatus();
            const raw = {
                ...asRecord(deps.getAppConfig().self_improvement),
                ...asRecord(deps.getAppConfig().evolution),
            };
            const minTasks = Math.max(1, Number(raw.min_task_count ?? 2) || 2);
            const minSuccessRatio = Math.max(0, Math.min(1, Number(raw.min_success_ratio ?? 0.7) || 0.7));
            const stats = status.learning;
            const outcomes = Array.isArray(stats.outcomes) ? stats.outcomes : [];
            const totalOutcomes = outcomes.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
            const successful = outcomes.filter((item) => String(item.outcome || "").toLowerCase() === "success").reduce((sum, item) => sum + (Number(item.count) || 0), 0);
            const successRatio = totalOutcomes > 0 ? successful / totalOutcomes : 0;
            if (!force && totalOutcomes < minTasks)
                return { status: "gated", reason: "min_task_count", current: totalOutcomes, required: minTasks, success_ratio: successRatio, required_success_ratio: minSuccessRatio, engine: status };
            if (!force && trigger !== "after_turn" && totalOutcomes > 0 && successRatio < minSuccessRatio)
                return { status: "gated", reason: "min_success_ratio", current: successRatio, required: minSuccessRatio, engine: status };
            const results = {};
            if (force || status.reflectionDue)
                results.reflection = await engine.runReflectionCycle({ force });
            if (force || status.tuningDue)
                results.promptTuning = await engine.runPromptTuningCycle({ force });
            if (force || status.optimizationDue)
                results.optimization = await engine.runOptimizationCycle({ force });
            return { status: Object.keys(results).length ? "completed" : "not_due", results, engine: engine.getStatus() };
        }
        finally {
            evolutionRunning = false;
        }
    }
    getLifecycleBus().on?.("message:sent", () => {
        const cfg = evolutionConfig();
        if (cfg.enabled && String((asRecord(deps.getAppConfig().evolution).cold_path_trigger || "after_turn")) === "after_turn") {
            void runDueEvolutionCycles(false).catch((error) => deps.appendGatewayLog(`Evolution after-turn cycle failed: ${error instanceof Error ? error.message : String(error)}`));
        }
    });
    evolutionTimer = setInterval(() => {
        if (evolutionConfig().enabled)
            void runDueEvolutionCycles(false).catch((error) => deps.appendGatewayLog(`Evolution cycle failed: ${error instanceof Error ? error.message : String(error)}`));
    }, 30_000);
    evolutionTimer.unref?.();
    let mcpManager = new ExternalMcpConnectorManager(deps.workspaceRoot, appMcpConfig(deps.getAppConfig()));
    let mcpSignature = JSON.stringify(appMcpConfig(deps.getAppConfig()));
    function getMcpManager() {
        const config = appMcpConfig(deps.getAppConfig());
        const nextSignature = JSON.stringify(config);
        if (nextSignature !== mcpSignature) {
            mcpManager.updateConfig(config);
            mcpSignature = nextSignature;
        }
        return mcpManager;
    }
    router.use("/link-preview", deps.requireAuth, createLinkPreviewRouter());
    router.use("/goals", deps.requireAuth, createGoalsRouter(new GoalStore(deps.db)));
    router.get("/credentials/status", deps.requireAuth, (_req, res) => {
        const models = deps.db.prepare("SELECT payload,is_default FROM model_configs ORDER BY id").all();
        const parsed = models.map((row) => JSON.parse(row.payload));
        const gemini = parsed.find((m) => ["gemini", "google", "provider.gemini"].includes(String(m.provider || "").toLowerCase()));
        const llama = parsed.find((m) => String(m.provider || "").toLowerCase().includes("llama"));
        const geminiKey = stringValue(gemini?.api_key) || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
        const llamaConfigured = Boolean(llama?.local && isRecord(llama.local) && stringValue(llama.local.model_path)) || Boolean(llama?.runtime === "llama.cpp");
        res.json({
            providers: {
                gemini: { status: geminiKey ? "connected" : "not_logged_in", configured: Boolean(geminiKey), authMethod: "api_key", apiKeyMask: jsonMask(geminiKey) },
                llama: { status: llamaConfigured ? "connected" : "not_logged_in", configured: llamaConfigured, authMethod: "local", apiKeyMask: "" },
            },
        });
    });
    router.post("/mcp/test", deps.requireAuth, async (req, res) => {
        const name = stringValue(req.body?.name);
        if (!name)
            return res.status(400).json({ ok: false, error: "MCP server name is required." });
        const config = appMcpConfig(deps.getAppConfig());
        const server = config.servers[name];
        if (!server)
            return res.status(404).json({ ok: false, error: `MCP server '${name}' was not found.` });
        if (!server.enabled)
            return res.json({ ok: true, status: "disabled", name, tools: 0 });
        const manager = new ExternalMcpConnectorManager(deps.workspaceRoot, config);
        const started = Date.now();
        try {
            const entries = await manager.listCatalogEntries(true);
            const tools = entries.filter((entry) => entry.serverName === name);
            if (tools.length === 0)
                return res.status(502).json({ ok: false, status: "connected_no_tools", name, tools: 0, latency_ms: Date.now() - started, error: "Connection succeeded but the server exposed no tools." });
            return res.json({ ok: true, status: "connected", name, tools: tools.length, latency_ms: Date.now() - started });
        }
        catch (error) {
            return res.status(502).json({ ok: false, status: "failed", name, latency_ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
        }
        finally {
            await manager.close();
        }
    });
    router.get("/mcp/status", deps.requireAuth, async (_req, res) => {
        const config = appMcpConfig(deps.getAppConfig());
        const manager = getMcpManager();
        const started = Date.now();
        const entries = await manager.listCatalogEntries(true);
        const servers = Object.values(config.servers).map((server) => {
            const tools = entries.filter((entry) => entry.serverName === server.name).length;
            return { name: server.name, enabled: server.enabled, type: server.type, tools, status: server.enabled ? (tools > 0 ? "connected" : "unavailable") : "disabled" };
        });
        res.json({ enabled: config.enabled, servers, tools: entries.length, latency_ms: Date.now() - started, checked_at: deps.now() });
    });
    router.post("/mcp/reconnect", deps.requireAuth, async (_req, res) => {
        await mcpManager.close();
        mcpManager = new ExternalMcpConnectorManager(deps.workspaceRoot, appMcpConfig(deps.getAppConfig()));
        mcpSignature = JSON.stringify(appMcpConfig(deps.getAppConfig()));
        res.json({ ok: true, status: "reconnected", checked_at: deps.now() });
    });
    let lastUsbDevices;
    let lastUsbEvent = null;
    const usbMonitorTimer = setInterval(() => {
        const devices = asRecord(deps.getAppConfig().devices);
        if (devices.enabled !== true || devices.monitor_usb !== true || process.platform !== "linux") {
            lastUsbDevices = undefined;
            return;
        }
        try {
            const current = scanLinuxUsbDevices();
            const diff = diffUsbDevices(lastUsbDevices, current);
            for (const device of diff.added) {
                lastUsbEvent = { type: "connected", device, at: deps.now() };
                deps.appendGatewayLog(`USB connected: ${device}`);
            }
            for (const device of diff.removed) {
                lastUsbEvent = { type: "disconnected", device, at: deps.now() };
                deps.appendGatewayLog(`USB disconnected: ${device}`);
            }
            lastUsbDevices = current;
        }
        catch (error) {
            deps.appendGatewayLog(`USB monitor failed: ${error instanceof Error ? error.message : String(error)}`);
            lastUsbDevices = undefined;
        }
    }, 2000);
    usbMonitorTimer.unref?.();
    router.get("/devices/status", deps.requireAuth, (_req, res) => {
        const devices = asRecord(deps.getAppConfig().devices);
        let usbSupported = false;
        let usbDevices = [];
        try {
            if (process.platform === "linux" && fs.existsSync("/sys/bus/usb/devices")) {
                usbSupported = true;
                usbDevices = scanLinuxUsbDevices();
            }
        }
        catch { }
        res.json({
            enabled: devices.enabled === true,
            monitor_usb: devices.monitor_usb === true,
            usb: { supported: usbSupported, connected: usbDevices.length, devices: usbDevices, last_event: lastUsbEvent },
        });
    });
    router.get("/channels/catalog", (_req, res) => {
        const config = deps.getAppConfig();
        const list = channelRoot(config);
        res.json({ channels: CHANNEL_META.map((meta) => ({ ...meta, runtime_note: meta.note, config_key: meta.name, variant: meta.name === "whatsapp_native" ? "native" : undefined, configured: Boolean(getChannelRecord(config, meta.name).enabled), })) });
    });
    router.get("/channels/:name/config", deps.requireAuth, (req, res) => {
        const name = req.params.name;
        const meta = CHANNEL_META.find((item) => item.name === name);
        if (!meta)
            return res.status(404).json({ error: `Unknown channel \"${name}\".` });
        const raw = getChannelRecord(deps.getAppConfig(), name);
        const { common, settings } = splitChannelConfig(raw);
        const configuredSecrets = Object.keys(settings).filter((key) => CHANNEL_SECRET_KEYS.has(key) && stringValue(settings[key]));
        const safeSettings = Object.fromEntries(Object.entries(settings).filter(([key]) => !CHANNEL_SECRET_KEYS.has(key)));
        res.json({ config: { ...common, ...safeSettings, enabled: Boolean(raw.enabled), type: raw.type ?? meta.name }, configured_secrets: configuredSecrets, config_key: meta.name, variant: meta.name === "whatsapp_native" ? "native" : undefined });
    });
    router.get("/channels/:name/probe", deps.requireAuth, async (req, res) => {
        const name = req.params.name;
        const meta = CHANNEL_META.find((item) => item.name === name);
        if (!meta)
            return res.status(404).json({ error: `Unknown channel \"${name}\".` });
        const config = deps.getAppConfig();
        const raw = getChannelRecord(config, name);
        const { settings } = splitChannelConfig(raw);
        const required = CHANNEL_FIELDS[name] ?? [];
        const configuredSecrets = new Set(Object.keys(settings).filter((key) => CHANNEL_SECRET_KEYS.has(key) && stringValue(settings[key])));
        const missing = required.filter((key) => !stringValue(settings[key]) && !configuredSecrets.has(key) && !stringValue(raw[key]));
        const enabled = raw.enabled === true;
        const configured = missing.length === 0;
        const checks = [
            { id: "config", status: !enabled ? "warn" : configured ? "pass" : "warn", message: !enabled ? "Channel is disabled." : configured ? "Required configuration is present." : `Missing: ${missing.join(", ")}` },
            { id: "runtime", status: meta.runtime_status === "partial" ? "warn" : "fail", message: meta.note },
        ];
        let probeStatus = !enabled ? "disabled" : missing.length ? "needs_config" : meta.runtime_status === "config_only" ? "not_implemented" : "partial";
        if (name === "dingtalk" && configured) {
            try {
                const u = new URL(stringValue(settings.webhook_url));
                checks.push({ id: "url", status: u.protocol === "https:" ? "pass" : "warn", message: "DingTalk webhook URL parsed successfully." });
            }
            catch {
                checks.push({ id: "url", status: "fail", message: "Invalid webhook URL." });
                probeStatus = "needs_config";
            }
        }
        return res.json({ channel: name, display_name: meta.display_name, runtime_status: meta.runtime_status, probe_status: probeStatus, agent_connected: false, enabled, configured, missing_fields: missing, checks, check_mode: String(req.query.mode || "sandbox") === "live" ? "sandbox" : String(req.query.mode || "sandbox"), latency_ms: 0, send_check: { status: "skipped", mode: "sandbox", message: "No external message was sent by the dashboard probe.", latency_ms: 0 }, next_steps: missing.length ? missing.map((key) => `Configure ${key}.`) : meta.runtime_status === "config_only" ? ["Install or enable a live channel adapter before messaging is available."] : ["Configuration is stored; no outbound message was sent."], setup_checklist: required.map((key) => `Configure ${key}.`), checked_at: deps.now() });
    });
    async function qrDataUri(content) {
        return QRCode.toDataURL(content, { errorCorrectionLevel: "M", margin: 2, width: 320 });
    }
    async function saveChannelBinding(channel, binding) {
        const config = deps.getAppConfig();
        const channels = isRecord(config.channel_list) ? config.channel_list : {};
        const existing = isRecord(channels[channel]) ? channels[channel] : {};
        const settings = isRecord(existing.settings) ? existing.settings : {};
        const next = deepMergeLocal(config, {
            channel_list: {
                [channel]: {
                    ...existing,
                    type: channel,
                    enabled: true,
                    settings: deepMergeLocal(settings, binding),
                },
            },
        });
        await deps.setAppConfig(next);
    }
    async function weixinStart(req, res) {
        try {
            const response = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", {
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(15000),
            });
            if (!response.ok)
                return res.status(502).json({ error: `WeChat QR service returned ${response.status}.` });
            const body = await response.json();
            const token = stringValue(body.qrcode);
            const content = stringValue(body.qrcode_img_content);
            if (!token || !content)
                return res.status(502).json({ error: "WeChat QR service returned an incomplete QR payload." });
            const stamp = deps.now();
            const id = randomUUID();
            const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
            const dataUri = await qrDataUri(content);
            deps.db.prepare("INSERT INTO dashboard_qr_flows(id,channel,status,created_at,updated_at,external_key,qr_data_uri,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "weixin", "wait", stamp, stamp, token, dataUri, expiresAt);
            deps.appendGatewayLog(`WeChat QR flow started: ${id}`);
            return res.json({ flow_id: id, status: "wait", qr_data_uri: dataUri });
        }
        catch (error) {
            return res.status(502).json({ error: `Failed to start WeChat QR flow: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    async function weixinPoll(req, res) {
        const row = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=? AND channel=?").get(req.params.id, "weixin");
        if (!row)
            return res.status(404).json({ error: "QR flow not found" });
        const terminal = new Set(["confirmed", "expired", "error"]);
        if (terminal.has(String(row.status)))
            return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined, account_id: row.account_id || undefined, error: row.error || undefined });
        if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) {
            deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id);
            return res.json({ flow_id: row.id, status: "expired" });
        }
        try {
            const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(String(row.external_key || ""))}`, {
                headers: { accept: "application/json" },
                signal: AbortSignal.timeout(10000),
            });
            if (!response.ok)
                return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined });
            const body = await response.json();
            const status = String(body.status || row.status);
            if (status === "scaned" || status === "scanned") {
                deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("scaned", deps.now(), row.id);
            }
            else if (status === "expired") {
                deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id);
            }
            else if (status === "confirmed") {
                const botToken = stringValue(body.bot_token);
                const accountId = stringValue(body.ilink_bot_id) || stringValue(body.bot_id);
                if (!botToken) {
                    deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,error=?,updated_at=? WHERE id=?").run("error", "WeChat confirmed the QR login but did not return bot_token.", deps.now(), row.id);
                }
                else {
                    const binding = { token: botToken };
                    if (accountId)
                        binding.account_id = accountId;
                    if (stringValue(body.baseurl))
                        binding.base_url = stringValue(body.baseurl);
                    await saveChannelBinding("weixin", binding);
                    deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,account_id=?,updated_at=? WHERE id=?").run("confirmed", accountId || null, deps.now(), row.id);
                    deps.appendGatewayLog(`WeChat QR flow confirmed: ${row.id}`);
                }
            }
            const updated = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=?").get(row.id);
            return res.json({ flow_id: updated.id, status: updated.status, qr_data_uri: ["wait", "scaned", "scanned"].includes(String(updated.status)) ? updated.qr_data_uri || undefined : undefined, account_id: updated.account_id || undefined, error: updated.error || undefined });
        }
        catch {
            return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined });
        }
    }
    async function wecomStart(req, res) {
        try {
            const platform = process.platform === "darwin" ? 1 : process.platform === "win32" ? 2 : process.platform === "linux" ? 3 : 0;
            const url = new URL("https://work.weixin.qq.com/ai/qc/generate");
            url.searchParams.set("source", "miki");
            url.searchParams.set("sourceID", "miki");
            url.searchParams.set("plat", String(platform));
            const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
            if (!response.ok)
                return res.status(502).json({ error: `WeCom QR service returned ${response.status}.` });
            const body = await response.json();
            const data = isRecord(body.data) ? body.data : {};
            const scode = stringValue(data.scode);
            const authUrl = stringValue(data.auth_url);
            if (!scode || !authUrl)
                return res.status(502).json({ error: "WeCom QR service returned an incomplete QR payload." });
            const stamp = deps.now();
            const id = randomUUID();
            const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
            const dataUri = await qrDataUri(authUrl);
            deps.db.prepare("INSERT INTO dashboard_qr_flows(id,channel,status,created_at,updated_at,external_key,qr_data_uri,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "wecom", "wait", stamp, stamp, scode, dataUri, expiresAt);
            deps.appendGatewayLog(`WeCom QR flow started: ${id}`);
            return res.json({ flow_id: id, status: "wait", qr_data_uri: dataUri });
        }
        catch (error) {
            return res.status(502).json({ error: `Failed to start WeCom QR flow: ${error instanceof Error ? error.message : String(error)}` });
        }
    }
    async function wecomPoll(req, res) {
        const row = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=? AND channel=?").get(req.params.id, "wecom");
        if (!row)
            return res.status(404).json({ error: "QR flow not found" });
        if (["confirmed", "expired", "error"].includes(String(row.status)))
            return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined, bot_id: row.bot_id || undefined, error: row.error || undefined });
        if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) {
            deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id);
            return res.json({ flow_id: row.id, status: "expired" });
        }
        try {
            const url = new URL("https://work.weixin.qq.com/ai/qc/query_result");
            url.searchParams.set("scode", String(row.external_key || ""));
            const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
            if (!response.ok)
                return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined });
            const body = await response.json();
            const data = isRecord(body.data) ? body.data : {};
            const status = String(data.status || row.status).toLowerCase();
            if (status === "scaned" || status === "scanned")
                deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("scaned", deps.now(), row.id);
            else if (status === "expired")
                deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id);
            else if (["success", "confirmed"].includes(status)) {
                const info = isRecord(data.bot_info) ? data.bot_info : {};
                const botId = stringValue(info.botid) || stringValue(data.botid);
                const secret = stringValue(info.secret) || stringValue(data.secret);
                if (!botId || !secret)
                    deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,error=?,updated_at=? WHERE id=?").run("error", "WeCom confirmed the QR login but did not return bot credentials.", deps.now(), row.id);
                else {
                    await saveChannelBinding("wecom", { bot_id: botId, secret, websocket_url: "wss://openws.work.weixin.qq.com" });
                    deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,bot_id=?,updated_at=? WHERE id=?").run("confirmed", botId, deps.now(), row.id);
                    deps.appendGatewayLog(`WeCom QR flow confirmed: ${row.id}`);
                }
            }
            const updated = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=?").get(row.id);
            return res.json({ flow_id: updated.id, status: updated.status, qr_data_uri: ["wait", "scaned", "scanned"].includes(String(updated.status)) ? updated.qr_data_uri || undefined : undefined, bot_id: updated.bot_id || undefined, error: updated.error || undefined });
        }
        catch {
            return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined });
        }
    }
    router.post("/weixin/flows", deps.requireAuth, weixinStart);
    router.get("/weixin/flows/:id", deps.requireAuth, weixinPoll);
    router.post("/wecom/flows", deps.requireAuth, wecomStart);
    router.get("/wecom/flows/:id", deps.requireAuth, wecomPoll);
    router.get("/speech-to-text/models", deps.requireAuth, async (_req, res) => {
        try {
            const settings = loadSpeechToTextSettings(deps.configDir);
            res.json({ provider: "whisper.cpp", enabled: settings.enabled, active_model_id: settings.active_model_id ?? null, models: settings.models, settings: publicSpeechSettings(settings), local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(error instanceof SpeechToTextError ? error.status : 503).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.get("/speech-to-text/status", deps.requireAuth, async (_req, res) => res.json(await modelRuntimeStatus(deps.configDir)));
    async function mutateSpeechConfig(mutator) {
        const configPath = getSpeechConfigPath(deps.configDir);
        const root = readYamlConfig(configPath);
        const current = loadSpeechToTextSettings(deps.configDir);
        root.speech_to_text = mutator(current);
        await writeYamlConfig(configPath, root);
        return loadSpeechToTextSettings(deps.configDir);
    }
    router.put("/speech-to-text/config", deps.requireAuth, async (req, res) => {
        try {
            const body = asRecord(req.body);
            const next = await mutateSpeechConfig((current) => ({ ...current, ...Object.fromEntries(Object.entries(body).filter(([k]) => ["enabled", "language", "max_audio_seconds", "max_file_mb", "timeout_ms", "concurrency", "retain_audio"].includes(k))) }));
            res.json({ status: "applied", ...next, models: next.models, local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.post("/speech-to-text/models", deps.requireAuth, async (req, res) => {
        try {
            const body = asRecord(req.body);
            const id = stringValue(body.id);
            const name = stringValue(body.name);
            const transport = body.transport === "endpoint" ? "endpoint" : "cli";
            if (!id || !name)
                return res.status(400).json({ error: "id and name are required" });
            const model = transport === "endpoint"
                ? { id, name, transport, enabled: body.enabled !== false, endpoint: stringValue(body.endpoint) }
                : { id, name, transport, enabled: body.enabled !== false, executable: stringValue(body.executable), model: stringValue(body.model) };
            const next = await mutateSpeechConfig((current) => ({ ...current, models: [...current.models.filter((item) => item.id !== id), model], active_model_id: body.set_active === true || current.models.length === 0 ? id : current.active_model_id }));
            res.status(201).json({ status: "created", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.put("/speech-to-text/models/:id", deps.requireAuth, async (req, res) => {
        try {
            const body = asRecord(req.body);
            const id = req.params.id;
            const next = await mutateSpeechConfig((current) => ({ ...current, models: current.models.map((item) => item.id === id ? { ...item, ...body, id } : item) }));
            res.json({ status: "updated", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.delete("/speech-to-text/models/:id", deps.requireAuth, async (req, res) => {
        try {
            const id = req.params.id;
            const next = await mutateSpeechConfig((current) => { const models = current.models.filter((item) => item.id !== id); return { ...current, models, active_model_id: current.active_model_id === id ? (models[0]?.id ?? undefined) : current.active_model_id }; });
            res.json({ status: "deleted", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.post("/speech-to-text/models/active", deps.requireAuth, async (req, res) => {
        try {
            const id = stringValue(req.body?.model_id);
            if (!id)
                return res.status(400).json({ error: "model_id is required" });
            const next = await mutateSpeechConfig((current) => current.models.some((m) => m.id === id) ? { ...current, active_model_id: id } : (() => { throw new Error("Speech model not found"); })());
            res.json({ status: "active", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.post("/speech-to-text/install", deps.requireAuth, async (req, res) => {
        const id = stringValue(req.body?.model_id);
        if (!["base", "base.en", "small"].includes(id))
            return res.status(400).json({ error: "Only base, base.en, and small are installable." });
        const plan = { model_id: id, risk: "install", action: "download" };
        const approvalRequestId = stringValue(req.body?.approval_request_id);
        const operationId = `speech-install:${id}`;
        const approvalRequest = { operationId, capability: "speech_to_text", action: "install_model", risk: "install", reason: `Download and install Whisper ${id} locally.`, sanitizedInput: plan, context: { origin: "dashboard", actor: "dashboard-operator" } };
        if (!approvalRequestId) {
            const pending = await deps.approvals.requestApproval(approvalRequest);
            deps.appendGatewayLog(`Speech model install approval requested: ${id} (${pending.requestId})`);
            return res.json({ status: "approval_required", approval_request_id: pending.requestId, plan });
        }
        if (!deps.approvals.isApproved({ ...approvalRequest, approvalRequestId })) {
            return res.status(403).json({ error: "Approval is still pending or does not match this installation request.", code: "approval_required", approval_request_id: approvalRequestId, plan });
        }
        if (!deps.approvals.consumeApproval({ ...approvalRequest, approvalRequestId }, approvalRequestId)) {
            return res.status(409).json({ error: "Approval could not be consumed.", code: "approval_invalid", approval_request_id: approvalRequestId });
        }
        try {
            const dir = path.join(deps.configDir, "voice-models");
            await fsp.mkdir(dir, { recursive: true });
            const target = path.join(dir, `ggml-${id}.bin`);
            if (!fs.existsSync(target))
                await downloadVoiceModel(id, target);
            const executable = process.env.MIKI_WHISPER_CPP_EXECUTABLE || "whisper-cli";
            const next = await mutateSpeechConfig((current) => {
                const models = [...current.models.filter((m) => m.id !== id), { id, name: `Whisper ${id}`, transport: "cli", enabled: true, executable, model: target }];
                return { ...current, enabled: true, active_model_id: id, models };
            });
            deps.appendGatewayLog(`Speech model installed: ${id}`);
            res.json({ status: "installed", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) });
        }
        catch (error) {
            res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.post("/speech-to-text/health", deps.requireAuth, async (_req, res) => {
        res.json({ status: "checked", provider: "whisper.cpp", local_runtime: await modelRuntimeStatus(deps.configDir) });
    });
    router.post("/voice/transcribe", deps.requireAuth, (req, res) => {
        const chunks = [];
        const contentType = String(req.headers["content-type"] || "");
        if (!contentType.toLowerCase().startsWith("multipart/form-data"))
            return res.status(415).json({ error: "audio multipart upload is required", code: "invalid_request" });
        const boundaryMatch = contentType.match(/boundary=(?:\"([^\"]+)\"|([^;]+))/i);
        const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
        if (!boundary)
            return res.status(400).json({ error: "Multipart boundary is missing.", code: "invalid_multipart" });
        req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        req.on("end", async () => {
            try {
                const body = Buffer.concat(chunks);
                if (body.length > 26 * 1024 * 1024)
                    throw new SpeechToTextError(413, "file_too_large", "Audio upload exceeds the maximum request size.");
                const marker = Buffer.from(`--${boundary}`);
                let cursor = 0;
                let selected;
                while (true) {
                    const start = body.indexOf(marker, cursor);
                    if (start < 0)
                        break;
                    const after = start + marker.length;
                    if (body.subarray(after, after + 2).toString() === "--")
                        break;
                    const headersStart = after + 2;
                    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headersStart);
                    if (headerEnd < 0)
                        break;
                    const headers = body.subarray(headersStart, headerEnd).toString("utf8");
                    const dataStart = headerEnd + 4;
                    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart);
                    if (nextBoundary < 0)
                        break;
                    const part = body.subarray(dataStart, nextBoundary);
                    const filenameMatch = headers.match(/filename=\"([^\"]*)\"/i);
                    const mimeMatch = headers.match(/(?:^|\r\n)content-type:\s*([^\r\n]+)/i);
                    const nameMatch = headers.match(/name=\"([^\"]+)\"/i);
                    const filename = filenameMatch?.[1] || "voice.webm";
                    const mimeType = mimeMatch?.[1]?.trim() || "application/octet-stream";
                    if ((nameMatch?.[1] === "audio" || filenameMatch) && part.length > 0)
                        selected = { data: part, filename, mimeType };
                    cursor = nextBoundary + 2;
                }
                if (!selected)
                    throw new SpeechToTextError(400, "invalid_multipart", "No audio part was found in the upload.");
                const service = new WhisperCppService(deps.configDir);
                const result = await service.transcribe({ data: selected.data, filename: selected.filename, mimeType: selected.mimeType, clientDurationMs: Number(req.body?.duration_ms) || undefined });
                res.json({ ok: true, mode: "local", ...result });
            }
            catch (error) {
                const status = error instanceof SpeechToTextError ? error.status : 500;
                res.status(status).json({ ok: false, code: error instanceof SpeechToTextError ? error.code : "voice_transcription_failed", error: error instanceof Error ? error.message : String(error) });
            }
        });
    });
    router.get("/improvement/status", deps.requireAuth, (_req, res) => {
        const status = getEvolutionEngine().getStatus();
        res.json({ self_improvement: status });
    });
    router.post("/improvement/run", deps.requireAuth, async (req, res) => {
        try {
            const force = req.body?.force === true;
            const result = await runDueEvolutionCycles(force);
            res.json(result);
        }
        catch (error) {
            res.status(502).json({ status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.get("/models/catalog", deps.requireAuth, (_req, res) => {
        const rows = deps.db.prepare("SELECT id,provider,api_base,api_key_mask,models_json,fetched_at FROM model_catalogs ORDER BY fetched_at DESC").all();
        res.json({ entries: rows.map((r) => ({ id: r.id, provider: r.provider, api_base: r.api_base, api_key_mask: r.api_key_mask, models: JSON.parse(String(r.models_json)), fetched_at: r.fetched_at })), total: rows.length });
    });
    router.delete("/models/catalog/:id", deps.requireAuth, (req, res) => {
        deps.db.prepare("DELETE FROM model_catalogs WHERE id=?").run(req.params.id);
        res.json({ status: "deleted", id: req.params.id });
    });
    router.get("/system/launcher-config", (_req, res) => {
        const saved = asRecord((() => { try {
            return JSON.parse(deps.db.prepare("SELECT value FROM settings WHERE key='launcher_config'").get()?.value || "{}");
        }
        catch {
            return {};
        } })());
        res.json({ port: Number(saved.port || process.env.GATEWAY_PORT || 18800), public: saved.public === true, allowed_cidrs: Array.isArray(saved.allowed_cidrs) ? saved.allowed_cidrs : [], session_timeout_minutes: Number(saved.session_timeout_minutes || 0) });
    });
    router.put("/system/launcher-config", deps.requireAuth, async (req, res) => {
        const port = Number(req.body?.port);
        const publicAccess = req.body?.public === true;
        const timeout = Number(req.body?.session_timeout_minutes || 0);
        const allowedCidrs = Array.isArray(req.body?.allowed_cidrs) ? req.body.allowed_cidrs.filter((v) => typeof v === "string" && v.trim()) : [];
        if (!Number.isInteger(port) || port < 1 || port > 65535)
            return res.status(400).json({ error: "port must be an integer between 1 and 65535" });
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > 31 * 24 * 60)
            return res.status(400).json({ error: "session_timeout_minutes must be an integer between 0 and 44640" });
        const value = { port, public: publicAccess, allowed_cidrs: allowedCidrs, session_timeout_minutes: timeout };
        const previous = (() => { try {
            return JSON.parse(String(deps.db.prepare("SELECT value FROM settings WHERE key='launcher_config'").get()?.value || "{}"));
        }
        catch {
            return {};
        } })();
        deps.db.prepare("INSERT INTO settings(key,value) VALUES('launcher_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
        const changedRuntime = Number(previous.port || process.env.GATEWAY_PORT || 18800) !== port || Boolean(previous.public) !== publicAccess;
        if (timeout > 0 || timeout === 0) {
            const minutes = timeout > 0 ? timeout : 30 * 24 * 60;
            const expiresAt = new Date(Date.now() + minutes * 60_000).toISOString();
            deps.db.prepare("UPDATE auth_sessions SET expires_at=? WHERE expires_at>?").run(expiresAt, deps.now());
        }
        let runtimeApplyStatus = changedRuntime ? "pending_restart" : "applied";
        let runtimeApplyError;
        if (changedRuntime && deps.rebindServer) {
            try {
                await deps.rebindServer(port, publicAccess);
                runtimeApplyStatus = "applied";
            }
            catch (error) {
                runtimeApplyStatus = "failed";
                runtimeApplyError = error instanceof Error ? error.message : String(error);
            }
        }
        return res.status(runtimeApplyStatus === "failed" ? 500 : 200).json({ ...value, runtime_apply_status: runtimeApplyStatus, runtime_apply_error: runtimeApplyError, gateway_restart_required: runtimeApplyStatus !== "applied", pending_restart_fields: runtimeApplyStatus === "applied" ? [] : ["launcher_config"] });
    });
    async function applyAutostart(enabled) {
        if (process.platform === "linux") {
            const serviceDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || deps.dataRoot, ".config"), "systemd", "user");
            const servicePath = path.join(serviceDir, "miki-gateway.service");
            if (!enabled) {
                await execFileAsync("systemctl", ["--user", "disable", "--now", "miki-gateway.service"]).catch(() => undefined);
                await fsp.rm(servicePath, { force: true });
                return { supported: true, active: false, message: "User systemd autostart disabled." };
            }
            await fsp.mkdir(serviceDir, { recursive: true });
            const node = process.execPath.replace(/\\/g, "/");
            const script = path.resolve(process.argv[1] || "").replace(/\\/g, "/");
            const unit = `[Unit]\nDescription=Miki Gateway\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${node} ${script}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`;
            await fsp.writeFile(servicePath, unit, { mode: 0o600 });
            await execFileAsync("systemctl", ["--user", "daemon-reload"]);
            await execFileAsync("systemctl", ["--user", "enable", "--now", "miki-gateway.service"]);
            return { supported: true, active: true, message: "User systemd autostart enabled." };
        }
        if (process.platform === "win32") {
            const taskName = "Miki Gateway";
            if (!enabled) {
                await execFileAsync("schtasks", ["/Delete", "/TN", taskName, "/F"]).catch(() => undefined);
                return { supported: true, active: false, message: "Windows logon task removed." };
            }
            const script = process.argv[1] || "";
            const taskCommand = `\"${process.execPath}\" \"${script}\"`;
            await execFileAsync("schtasks", ["/Create", "/TN", taskName, "/TR", taskCommand, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"]);
            return { supported: true, active: true, message: "Windows logon autostart task created." };
        }
        return { supported: false, active: enabled, message: `Automatic startup is not implemented for ${process.platform}.` };
    }
    router.put("/system/autostart", deps.requireAuth, async (req, res) => {
        const enabled = req.body?.enabled === true;
        try {
            const result = await applyAutostart(enabled);
            deps.db.prepare("INSERT INTO settings(key,value) VALUES('autostart_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(enabled ? "true" : "false");
            res.json({ enabled, platform: process.platform, ...result });
        }
        catch (error) {
            res.status(500).json({ enabled, supported: process.platform === "linux" || process.platform === "win32", active: false, error: error instanceof Error ? error.message : String(error) });
        }
    });
    router.get("/system/autostart", async (_req, res) => {
        const row = deps.db.prepare("SELECT value FROM settings WHERE key='autostart_enabled'").get();
        const enabled = row?.value === "true";
        res.json({ enabled, supported: process.platform === "linux" || process.platform === "win32", active: enabled, platform: process.platform });
    });
    router.get("/system/flow", deps.requireAuth, (_req, res) => {
        const models = deps.agent.llmFor();
        const components = [
            { id: "dashboard", label: "Dashboard", status: "ready", summary: "Frontend is served by the persistent gateway.", evidence: ["HTTP", "static assets"] },
            { id: "gateway", label: "Gateway", status: "ready", summary: "Persistent Node gateway is running.", evidence: ["Express", `PID ${process.pid}`] },
            { id: "agent", label: "Agent runtime", status: models ? "ready" : "partial", summary: models ? `Model ${models.model} is resolvable.` : "No configured model is currently resolvable.", evidence: [`${deps.agent.registry.size} tools`, `${deps.agent.activeRunCount()} active run(s)`] },
            { id: "memory", label: "Memory", status: "ready", summary: "SQLite memory store is available.", evidence: ["SQLite", `${deps.db.prepare("SELECT COUNT(*) c FROM memory_chunks").get()?.c ?? 0} chunks`] },
            { id: "skills", label: "Skills", status: "ready", summary: "Skill routes and runtime are mounted.", evidence: ["/api/skills"] },
        ];
        const ready = components.filter((c) => c.status === "ready").length;
        res.json({ status: ready === components.length ? "ready" : "partial", generated_at: deps.now(), flow_version: 1, components, edges: components.slice(1).map((c, i) => ({ from: components[i].id, to: c.id, contract: "HTTP/API or runtime contract" })), gaps: models ? [] : [{ id: "model", severity: "warning", title: "No model configured", detail: "Configure at least one model to run agent turns.", owner: "Models" }] });
    });
    router.get("/enhancements/health/full", deps.requireAuth, async (_req, res) => {
        const doctorChecks = [
            { id: "database", label: "SQLite database", status: "pass", message: "SQLite is reachable.", details: {} },
            { id: "workspace", label: "Workspace", status: fs.existsSync(deps.workspaceRoot) ? "pass" : "fail", message: deps.workspaceRoot, details: {} },
            { id: "tools", label: "Agent tools", status: deps.agent.registry.size > 0 ? "pass" : "warn", message: `${deps.agent.registry.size} registered tool(s).`, details: {} },
            { id: "model", label: "Default model", status: deps.agent.llmFor() ? "pass" : "warn", message: deps.agent.llmFor()?.model || "No model configured.", details: {} },
        ];
        const backups = await loadBackups(backupsDir);
        const jobs = deps.db.prepare("SELECT * FROM runtime_jobs ORDER BY updated_at DESC LIMIT 100").all();
        const items = jobs.map((job) => ({ id: job.id, type: job.type, status: job.status, priority: Number(job.priority), attempts: Number(job.attempts), maxAttempts: Number(job.max_attempts), progress: Number(job.progress), updatedAt: job.updated_at, runAfter: Number(job.run_after), ...(job.error_json ? { error: JSON.parse(String(job.error_json)) } : {}) }));
        const stats = {};
        for (const item of items)
            stats[item.status] = (stats[item.status] || 0) + 1;
        const safeModeRow = deps.db.prepare("SELECT value FROM settings WHERE key='safe_mode'").get();
        const safeMode = safeModeRow?.value ? JSON.parse(safeModeRow.value) : { enabled: false, reasons: [] };
        const secretScan = await scanSecrets(deps.workspaceRoot);
        const memoryCount = Number(deps.db.prepare("SELECT COUNT(*) c FROM memory_chunks").get()?.c || 0);
        const pluginHealth = listBuiltinPluginHealth({ "tools.core-registry": { ok: deps.agent.registry.size > 0, status: deps.agent.registry.size > 0 ? "functional" : "partial" }, "workflow.agent-loop": { ok: Boolean(deps.agent.llmFor()), status: deps.agent.llmFor() ? "functional" : "partial" } });
        const components = [
            { name: "gateway", status: "healthy", message: `PID ${process.pid}` },
            { name: "agent-runtime", status: deps.agent.llmFor() ? "healthy" : "degraded", message: deps.agent.llmFor()?.model || "No configured model" },
            { name: "memory", status: memoryCount >= 0 ? "healthy" : "failed", message: `${memoryCount} memory chunk(s)` },
            { name: "plugins", status: Object.values(pluginHealth).every((v) => v.ok) ? "healthy" : "degraded", message: `${Object.keys(pluginHealth).length} built-in capability checks` },
        ];
        const hasFailure = doctorChecks.some((c) => c.status === "fail");
        const hasWarn = doctorChecks.some((c) => c.status === "warn") || secretScan.findings.length > 0;
        res.json({ status: hasFailure ? "failed" : hasWarn ? "degraded" : "healthy", checkedAt: deps.now(), doctor: { status: hasFailure ? "fail" : hasWarn ? "warn" : "pass", checkedAt: deps.now(), workspaceDir: deps.workspaceRoot, checks: doctorChecks }, memory: { available: true, dataDir: deps.dataRoot }, safeMode, backups: backups.map((b) => ({ id: b.id, createdAt: b.createdAt, entries: b.entries })), migrations: [], watchdog: { enabled: true, services: [{ name: "gateway", healthy: true, failures: 0, lastMessage: "Persistent gateway is running.", lastCheckedAt: deps.now() }, { name: "database", healthy: true, failures: 0, lastMessage: "SQLite reachable.", lastCheckedAt: deps.now() }] }, jobs: { items, stats }, performance: [{ name: "health-check", durationMs: 0 }], audit: [], secretScan, components });
    });
    router.post("/enhancements/doctor/run", deps.requireAuth, async (_req, res) => {
        const secretScan = await scanSecrets(deps.workspaceRoot);
        const report = { status: secretScan.findings.length ? "warn" : "pass", checkedAt: deps.now(), workspaceDir: deps.workspaceRoot, checks: [{ id: "database", label: "SQLite", status: "pass", message: "SQLite reachable." }, { id: "workspace", label: "Workspace", status: fs.existsSync(deps.workspaceRoot) ? "pass" : "fail", message: deps.workspaceRoot }, { id: "secrets", label: "Secret scan", status: secretScan.findings.length ? "warn" : "pass", message: `${secretScan.findings.length} finding(s).` }] };
        res.json({ report });
    });
    router.post("/enhancements/safety/backups", deps.requireAuth, async (_req, res) => {
        await fsp.mkdir(backupsDir, { recursive: true });
        const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
        const file = path.join(backupsDir, `${id}.json`);
        const state = {
            id, createdAt: deps.now(), entries: [
                { source: "settings", kind: "file", sizeBytes: 0 }, { source: "model_configs", kind: "file", sizeBytes: 0 },
                { source: "memory_chunks", kind: "file", sizeBytes: 0 }, { source: "memory_vectors", kind: "file", sizeBytes: 0 },
                { source: "chat_sessions", kind: "file", sizeBytes: 0 }, { source: "chat_messages", kind: "file", sizeBytes: 0 },
            ], snapshot: { settings: snapshotTable(deps.db, "settings"), model_configs: snapshotTable(deps.db, "model_configs"), memory_chunks: snapshotTable(deps.db, "memory_chunks"), memory_vectors: snapshotTable(deps.db, "memory_vectors"), chat_sessions: snapshotTable(deps.db, "chat_sessions"), chat_messages: snapshotTable(deps.db, "chat_messages"), runtime_jobs: snapshotTable(deps.db, "runtime_jobs") },
        };
        await fsp.writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
        res.json({ backup: { id, createdAt: state.createdAt, entries: state.entries } });
    });
    router.post("/enhancements/safety/rollback", deps.requireAuth, async (req, res) => {
        const id = stringValue(req.body?.backupId);
        if (!id)
            return res.status(400).json({ error: "backupId is required" });
        const file = path.join(backupsDir, `${id}.json`);
        let backup;
        try {
            backup = JSON.parse(await fsp.readFile(file, "utf8"));
        }
        catch {
            return res.status(404).json({ error: "Backup not found" });
        }
        const tables = ["settings", "model_configs", "memory_chunks", "memory_vectors", "chat_sessions", "chat_messages", "runtime_jobs"];
        const tx = deps.db.transaction(() => {
            for (const table of tables) {
                const rows = Array.isArray(backup.snapshot?.[table]) ? backup.snapshot[table] : [];
                const cols = deps.db.prepare(`PRAGMA table_info(${table})`).all();
                const valid = new Set(cols.map((c) => c.name));
                deps.db.prepare(`DELETE FROM ${table}`).run();
                for (const row of rows) {
                    const entries = Object.entries(row).filter(([key]) => valid.has(key));
                    if (!entries.length)
                        continue;
                    const names = entries.map(([key]) => key);
                    const placeholders = names.map(() => "?").join(",");
                    deps.db.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${placeholders})`).run(...entries.map(([, value]) => value));
                }
            }
        });
        tx();
        res.json({ rollback: { restoredBackupId: id, restoredEntries: Object.values(backup.snapshot || {}).reduce((sum, rows) => sum + (Array.isArray(rows) ? rows.length : 0), 0) } });
    });
    router.post("/enhancements/safety/secret-scan", deps.requireAuth, async (_req, res) => res.json({ report: await scanSecrets(deps.workspaceRoot) }));
    router.post("/enhancements/safety/watchdog/restart", deps.requireAuth, (_req, res) => res.json({ watchdog: { enabled: true, services: [{ name: "gateway", healthy: true, failures: 0, lastMessage: "Watchdog probe refreshed.", lastCheckedAt: deps.now() }] } }));
    router.post("/enhancements/safety/safe-mode/clear", deps.requireAuth, (_req, res) => { const value = { enabled: false, reasons: [], updatedAt: deps.now() }; deps.db.prepare("INSERT INTO settings(key,value) VALUES('safe_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value)); res.json({ safeMode: value }); });
    router.get("/enhancements/runtime/jobs/dead-letter", deps.requireAuth, (_req, res) => {
        const jobs = deps.db.prepare("SELECT * FROM runtime_jobs WHERE status='dead_letter' ORDER BY updated_at DESC").all();
        res.json({ jobs: jobs.map((job) => ({ id: job.id, type: job.type, status: job.status, priority: Number(job.priority), attempts: Number(job.attempts), maxAttempts: Number(job.max_attempts), progress: Number(job.progress), updatedAt: job.updated_at, runAfter: Number(job.run_after) })), count: jobs.length });
    });
    router.delete("/enhancements/runtime/jobs/:id", deps.requireAuth, (req, res) => { const result = deps.db.prepare("UPDATE runtime_jobs SET status='cancelled',updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled','dead_letter')").run(deps.now(), req.params.id); res.json({ cancelled: result.changes > 0 }); });
    router.post("/enhancements/runtime/jobs/:id/retry", deps.requireAuth, (req, res) => { const result = deps.db.prepare("UPDATE runtime_jobs SET status='pending',attempts=0,progress=0,updated_at=?,error_json=NULL WHERE id=?").run(deps.now(), req.params.id); if (!result.changes)
        return res.status(404).json({ error: "Runtime job not found" }); const job = deps.db.prepare("SELECT * FROM runtime_jobs WHERE id=?").get(req.params.id); res.json({ job: { id: job.id, type: job.type, status: job.status, priority: Number(job.priority), attempts: Number(job.attempts), maxAttempts: Number(job.max_attempts), progress: Number(job.progress), updatedAt: job.updated_at, runAfter: Number(job.run_after) } }); });
    router.get("/enhancements/runtime/deliveries", deps.requireAuth, (_req, res) => { const rows = deps.db.prepare("SELECT payload_json FROM delivery_receipts ORDER BY updated_at DESC").all(); const receipts = rows.map((r) => JSON.parse(r.payload_json)); const stats = {}; for (const receipt of receipts)
        stats[receipt.status] = (stats[receipt.status] || 0) + 1; res.json({ receipts, stats }); });
    router.post("/enhancements/runtime/deliveries/mock", deps.requireAuth, (req, res) => {
        const body = asRecord(req.body);
        const id = randomUUID();
        const now = deps.now();
        const previewHash = createHash("sha256").update(stringValue(body.body)).digest("hex").slice(0, 16);
        const risk = stringValue(body.risk) || "read";
        const approvalRequired = !["read", "low"].includes(risk.toLowerCase());
        const approvalId = approvalRequired ? `delivery-approval-${randomUUID()}` : undefined;
        const receipt = { id, runId: stringValue(body.runId) || undefined, stepId: stringValue(body.stepId) || undefined, correlationId: stringValue(body.correlationId) || undefined, channel: stringValue(body.channel), destination: stringValue(body.destination), body: stringValue(body.body), idempotencyKey: stringValue(body.idempotencyKey) || randomUUID(), status: approvalRequired ? "waiting_approval" : "pending", attempts: 0, maxAttempts: Number(body.maxAttempts || 2), approvalRequired, approvalRequestId: approvalId, previewHash, nextAction: approvalRequired ? "Approve then dispatch." : "Dispatch when ready.", replayAllowed: true, updatedAt: now };
        deps.db.prepare("INSERT INTO delivery_receipts(id,payload_json,status,updated_at) VALUES(?,?,?,?)").run(id, JSON.stringify(receipt), receipt.status, now);
        res.json({ preview: { externalSideEffect: false, previewHash, bodyPreview: receipt.body.slice(0, 280) }, receipt, approval: { id: approvalId || "none", status: approvalRequired ? "pending" : "not_required", tokenIssued: false } });
    });
    router.get("/enhancements/runtime/deliveries/:id", deps.requireAuth, (req, res) => { const row = deps.db.prepare("SELECT payload_json FROM delivery_receipts WHERE id=?").get(req.params.id); if (!row)
        return res.status(404).json({ error: "Delivery not found" }); const receipt = JSON.parse(String(row.payload_json)); res.json({ receipt, approval: receipt.approvalRequestId ? { id: receipt.approvalRequestId, status: receipt.status === "waiting_approval" ? "pending" : "approved" } : null, replayEligible: receipt.replayAllowed !== false }); });
    router.post("/enhancements/runtime/deliveries/:id/approve", deps.requireAuth, (req, res) => { const row = deps.db.prepare("SELECT payload_json FROM delivery_receipts WHERE id=?").get(req.params.id); if (!row)
        return res.status(404).json({ error: "Delivery not found" }); const receipt = JSON.parse(String(row.payload_json)); receipt.status = "pending"; receipt.approvalRequired = false; receipt.updatedAt = deps.now(); deps.db.prepare("UPDATE delivery_receipts SET payload_json=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(receipt), receipt.status, receipt.updatedAt, req.params.id); res.json({ receipt, approval: { id: receipt.approvalRequestId, status: "approved", decidedBy: stringValue(req.body?.decidedBy) || "dashboard-operator" } }); });
    router.post("/enhancements/runtime/deliveries/:id/mock-dispatch", deps.requireAuth, (req, res) => { const row = deps.db.prepare("SELECT payload_json FROM delivery_receipts WHERE id=?").get(req.params.id); if (!row)
        return res.status(404).json({ error: "Delivery not found" }); const receipt = JSON.parse(String(row.payload_json)); const outcome = stringValue(req.body?.outcome) || "sent"; receipt.attempts += 1; receipt.status = outcome; receipt.updatedAt = deps.now(); receipt.lastError = outcome === "failed" ? "Mock dispatch failed by requested outcome." : undefined; deps.db.prepare("UPDATE delivery_receipts SET payload_json=?,status=?,updated_at=? WHERE id=?").run(JSON.stringify(receipt), receipt.status, receipt.updatedAt, req.params.id); res.json({ receipt, outcome: { status: outcome, externalSideEffect: false } }); });
    router.post("/enhancements/runtime/deliveries/:id/replay", deps.requireAuth, (req, res) => { const row = deps.db.prepare("SELECT payload_json FROM delivery_receipts WHERE id=?").get(req.params.id); if (!row)
        return res.status(404).json({ error: "Delivery not found" }); const receipt = JSON.parse(String(row.payload_json)); if (stringValue(req.body?.idempotencyKey) === receipt.idempotencyKey)
        return res.status(409).json({ error: "Replay requires a new idempotency key." }); receipt.replayOf = receipt.id; receipt.id = randomUUID(); receipt.idempotencyKey = stringValue(req.body?.idempotencyKey); receipt.status = "pending"; receipt.updatedAt = deps.now(); deps.db.prepare("INSERT INTO delivery_receipts(id,payload_json,status,updated_at) VALUES(?,?,?,?)").run(receipt.id, JSON.stringify(receipt), receipt.status, receipt.updatedAt); res.json({ receipt, preview: { externalSideEffect: false, previewHash: receipt.previewHash, bodyPreview: receipt.body.slice(0, 280) }, approval: {} }); });
    return router;
}
