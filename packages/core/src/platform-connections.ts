import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import type { SecretVault } from "@miki/config";

export type PlatformProvider =
  | "facebook"
  | "youtube"
  | "x"
  | "telegram"
  | "whatsapp"
  | "instagram"
  | "linkedin"
  | "discord"
  | "slack"
  | "webhook";

export type ConnectionStatus =
  | "needs_browser"
  | "awaiting_user"
  | "needs_validation"
  | "connected"
  | "restricted"
  | "token_expiring"
  | "revoked"
  | "failed";

export type ConnectionSessionStatus =
  | "created"
  | "browser_opened"
  | "awaiting_user"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";

export interface PlatformCapability {
  id: string;
  label: string;
  available: boolean;
  requiresApproval: boolean;
  notes: string;
}

export interface PlatformDescriptor {
  id: PlatformProvider;
  label: string;
  category: "social" | "messaging" | "developer" | "utility";
  officialUrl: string;
  connectionMode: "oauth" | "bot_token" | "api_key" | "browser_bridge";
  implementation: "planned" | "partial" | "ready";
  capabilities: PlatformCapability[];
  requiredScopes: string[];
  setupSteps: string[];
}

export interface PlatformConnection {
  id: string;
  provider: PlatformProvider;
  accountLabel: string;
  externalAccountId?: string;
  status: ConnectionStatus;
  scopes: string[];
  credentialRef?: string;
  browserSessionId?: string;
  lastValidatedAt?: string;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
  healthMessage: string;
}

export interface BrowserConnectionSession {
  id: string;
  provider: PlatformProvider;
  status: ConnectionSessionStatus;
  requestedScopes: string[];
  officialUrl: string;
  expectedDomain: string;
  createdAt: string;
  expiresAt: string;
  completedAt?: string;
  connectionId?: string;
  userActionRequired: string;
}

export interface BeginConnectionInput {
  provider: PlatformProvider;
  scopes?: string[];
}

export interface CompleteConnectionInput {
  accountLabel: string;
  externalAccountId?: string;
  scopes?: string[];
  credentialRef?: string;
  expiresAt?: string;
}

const PROVIDERS: PlatformDescriptor[] = [
  {
    id: "facebook",
    label: "Facebook Pages",
    category: "social",
    officialUrl: "https://developers.facebook.com/",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["pages_manage_posts", "pages_read_engagement"],
    capabilities: [
      {
        id: "page_post",
        label: "Page post",
        available: false,
        requiresApproval: true,
        notes: "Meta adapter and app review are required.",
      },
    ],
    setupSteps: [
      "Open Meta for Developers in your browser.",
      "Log in and grant only the requested Page permissions.",
      "Complete app review or use a test Page.",
      "Return to Miki and run a read-only connection test.",
    ],
  },
  {
    id: "youtube",
    label: "YouTube",
    category: "social",
    officialUrl: "https://console.cloud.google.com/",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["https://www.googleapis.com/auth/youtube.upload"],
    capabilities: [
      {
        id: "video_publish",
        label: "Video publish",
        available: false,
        requiresApproval: true,
        notes: "Google OAuth, quota, and upload adapter are required.",
      },
    ],
    setupSteps: [
      "Open Google Cloud Console in your browser.",
      "Select or create a project and enable YouTube Data API.",
      "Complete Google consent for the target channel.",
      "Run a read-only channel health check.",
    ],
  },
  {
    id: "x",
    label: "X",
    category: "social",
    officialUrl: "https://developer.x.com/",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["tweet.read", "tweet.write", "users.read"],
    capabilities: [
      {
        id: "post",
        label: "Post or thread",
        available: false,
        requiresApproval: true,
        notes: "X API access tier and OAuth scopes are required.",
      },
    ],
    setupSteps: [
      "Open the official X Developer Portal.",
      "Choose an approved project and app.",
      "Review write permissions and account tier.",
      "Complete browser consent and read-only validation.",
    ],
  },
  {
    id: "telegram",
    label: "Telegram",
    category: "messaging",
    officialUrl: "https://t.me/BotFather",
    connectionMode: "bot_token",
    implementation: "planned",
    requiredScopes: ["bot_message_send"],
    capabilities: [
      {
        id: "send_message",
        label: "Send bot message",
        available: false,
        requiresApproval: true,
        notes: "Bot token intake and Telegram adapter are required.",
      },
    ],
    setupSteps: [
      "Open BotFather in your browser.",
      "Create or select a bot.",
      "Complete secure token intake without placing the token in a normal task prompt.",
      "Run a read-only bot identity check.",
    ],
  },
  {
    id: "whatsapp",
    label: "WhatsApp Cloud API",
    category: "messaging",
    officialUrl: "https://developers.facebook.com/docs/whatsapp/cloud-api/",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["whatsapp_business_messaging"],
    capabilities: [
      {
        id: "template_message",
        label: "Approved template message",
        available: false,
        requiresApproval: true,
        notes:
          "Business verification, templates, consent, and webhook validation are required.",
      },
    ],
    setupSteps: [
      "Open Meta Business tools in your browser.",
      "Complete Business verification and phone setup.",
      "Use only approved templates and opted-in recipients.",
      "Validate webhook signatures before sending.",
    ],
  },
  {
    id: "instagram",
    label: "Instagram Professional",
    category: "social",
    officialUrl: "https://developers.facebook.com/docs/instagram-api/",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["instagram_basic", "instagram_content_publish"],
    capabilities: [
      {
        id: "media_publish",
        label: "Media publish",
        available: false,
        requiresApproval: true,
        notes: "Professional account and Meta review are required.",
      },
    ],
    setupSteps: [
      "Open the official Instagram API documentation.",
      "Confirm the account is Professional and linked to a Page.",
      "Complete Meta consent and required review.",
      "Run a read-only account check.",
    ],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    category: "social",
    officialUrl: "https://www.linkedin.com/developers/",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["openid", "profile", "w_member_social"],
    capabilities: [
      {
        id: "share",
        label: "Share post",
        available: false,
        requiresApproval: true,
        notes: "LinkedIn product access and OAuth approval are required.",
      },
    ],
    setupSteps: [
      "Open the LinkedIn Developer Portal.",
      "Select an approved app and product.",
      "Complete browser consent.",
      "Run a read-only identity check.",
    ],
  },
  {
    id: "discord",
    label: "Discord",
    category: "messaging",
    officialUrl: "https://discord.com/developers/applications",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["bot", "applications.commands"],
    capabilities: [
      {
        id: "send_message",
        label: "Send channel message",
        available: false,
        requiresApproval: true,
        notes:
          "Bot installation and channel permission validation are required.",
      },
    ],
    setupSteps: [
      "Open Discord Developer Portal.",
      "Select or create an application.",
      "Install the bot only into an approved server.",
      "Run a read-only permission check.",
    ],
  },
  {
    id: "slack",
    label: "Slack",
    category: "messaging",
    officialUrl: "https://api.slack.com/apps",
    connectionMode: "oauth",
    implementation: "planned",
    requiredScopes: ["chat:write"],
    capabilities: [
      {
        id: "send_message",
        label: "Send channel message",
        available: false,
        requiresApproval: true,
        notes: "Workspace consent and Slack app scopes are required.",
      },
    ],
    setupSteps: [
      "Open Slack API Apps in your browser.",
      "Select or create an app.",
      "Install it only in the approved workspace.",
      "Run a read-only workspace check.",
    ],
  },
  {
    id: "webhook",
    label: "Generic Webhook",
    category: "utility",
    officialUrl: "",
    connectionMode: "api_key",
    implementation: "planned",
    requiredScopes: ["webhook_invoke"],
    capabilities: [
      {
        id: "invoke",
        label: "Invoke webhook",
        available: false,
        requiresApproval: true,
        notes: "Endpoint allowlisting and signed requests are required.",
      },
    ],
    setupSteps: [
      "Provide an allowlisted HTTPS endpoint through a secure connection flow.",
      "Configure request signing.",
      "Run a non-destructive validation request.",
      "Approve each external invocation policy.",
    ],
  },
];

function descriptor(provider: PlatformProvider): PlatformDescriptor {
  const found = PROVIDERS.find((entry) => entry.id === provider);
  if (!found) throw new Error(`Unsupported platform provider: ${provider}`);
  return found;
}

function asJson(value: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function toConnection(row: Record<string, unknown>): PlatformConnection {
  return {
    id: String(row.id),
    provider: String(row.provider) as PlatformProvider,
    accountLabel: String(row.account_label),
    externalAccountId:
      typeof row.external_account_id === "string"
        ? row.external_account_id
        : undefined,
    status: String(row.status) as ConnectionStatus,
    scopes: asJson(
      typeof row.scopes_json === "string" ? row.scopes_json : "[]",
    ),
    credentialRef:
      typeof row.credential_ref === "string" ? row.credential_ref : undefined,
    browserSessionId:
      typeof row.browser_session_id === "string"
        ? row.browser_session_id
        : undefined,
    lastValidatedAt:
      typeof row.last_validated_at === "string"
        ? row.last_validated_at
        : undefined,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : undefined,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    healthMessage: String(row.health_message),
  };
}

function toSession(row: Record<string, unknown>): BrowserConnectionSession {
  return {
    id: String(row.id),
    provider: String(row.provider) as PlatformProvider,
    status: String(row.status) as ConnectionSessionStatus,
    requestedScopes: asJson(
      typeof row.requested_scopes_json === "string"
        ? row.requested_scopes_json
        : "[]",
    ),
    officialUrl: String(row.official_url),
    expectedDomain: String(row.expected_domain),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
    completedAt:
      typeof row.completed_at === "string" ? row.completed_at : undefined,
    connectionId:
      typeof row.connection_id === "string" ? row.connection_id : undefined,
    userActionRequired: String(row.user_action_required),
  };
}

export class SqlitePlatformConnectionStore {
  private readonly db: Database.Database;
  private readonly credentialVault?: SecretVault;

  constructor(dbPath: string, credentialVault?: SecretVault) {
    this.credentialVault = credentialVault;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS platform_connections (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        account_label TEXT NOT NULL,
        external_account_id TEXT,
        status TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        credential_ref TEXT,
        browser_session_id TEXT,
        last_validated_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        health_message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_connection_sessions (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        requested_scopes_json TEXT NOT NULL,
        official_url TEXT NOT NULL,
        expected_domain TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        completed_at TEXT,
        connection_id TEXT,
        user_action_required TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_platform_connections_provider ON platform_connections(provider);
      CREATE INDEX IF NOT EXISTS idx_browser_sessions_status ON browser_connection_sessions(status);
    `);
  }

  listConnections(limit = 100): PlatformConnection[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM platform_connections ORDER BY updated_at DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(500, limit))) as Record<string, unknown>[];
    return rows.map(toConnection);
  }

  getConnection(id: string): PlatformConnection | undefined {
    const row = this.db
      .prepare("SELECT * FROM platform_connections WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toConnection(row) : undefined;
  }

  begin(input: BeginConnectionInput): BrowserConnectionSession {
    const info = descriptor(input.provider);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 15 * 60_000);
    const session: BrowserConnectionSession = {
      id: crypto.randomUUID(),
      provider: input.provider,
      status: "awaiting_user",
      requestedScopes: [
        ...new Set(input.scopes?.length ? input.scopes : info.requiredScopes),
      ],
      officialUrl: info.officialUrl,
      expectedDomain: new URL(info.officialUrl || "https://example.com")
        .hostname,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      userActionRequired:
        "Open the official provider page in your browser, complete login/consent, and return to Miki. Do not paste passwords, OTPs, or private secrets into chat.",
    };
    this.db
      .prepare(
        `INSERT INTO browser_connection_sessions (id, provider, status, requested_scopes_json, official_url, expected_domain, created_at, expires_at, user_action_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        session.provider,
        session.status,
        JSON.stringify(session.requestedScopes),
        session.officialUrl,
        session.expectedDomain,
        session.createdAt,
        session.expiresAt,
        session.userActionRequired,
      );
    return session;
  }

  getSession(id: string): BrowserConnectionSession | undefined {
    const row = this.db
      .prepare("SELECT * FROM browser_connection_sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? toSession(row) : undefined;
  }

  complete(
    sessionId: string,
    input: CompleteConnectionInput,
  ): { session: BrowserConnectionSession; connection: PlatformConnection } {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Browser connection session not found");
    if (
      session.status !== "awaiting_user" &&
      session.status !== "browser_opened"
    )
      throw new Error(`Connection session is ${session.status}`);
    if (Date.parse(session.expiresAt) <= Date.now())
      throw new Error("Browser connection session expired");
    if (!input.accountLabel.trim())
      throw new Error("Account label is required");
    if (
      input.credentialRef &&
      /token|secret|password|api[_-]?key/i.test(input.credentialRef)
    )
      throw new Error(
        "credentialRef must be an opaque vault reference, not a raw secret",
      );
    const now = new Date().toISOString();
    const connection: PlatformConnection = {
      id: crypto.randomUUID(),
      provider: session.provider,
      accountLabel: input.accountLabel.trim(),
      externalAccountId: input.externalAccountId?.trim() || undefined,
      status: "needs_validation",
      scopes: [
        ...new Set(
          input.scopes?.length ? input.scopes : session.requestedScopes,
        ),
      ],
      credentialRef: input.credentialRef?.trim() || undefined,
      browserSessionId: session.id,
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
      healthMessage:
        "Browser setup recorded. A read-only provider validation and adapter capability check are required before any external action.",
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO platform_connections (id, provider, account_label, external_account_id, status, scopes_json, credential_ref, browser_session_id, expires_at, created_at, updated_at, health_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          connection.id,
          connection.provider,
          connection.accountLabel,
          connection.externalAccountId ?? null,
          connection.status,
          JSON.stringify(connection.scopes),
          connection.credentialRef ?? null,
          connection.browserSessionId ?? null,
          connection.expiresAt ?? null,
          connection.createdAt,
          connection.updatedAt,
          connection.healthMessage,
        );
      this.db
        .prepare(
          "UPDATE browser_connection_sessions SET status = ?, completed_at = ?, connection_id = ? WHERE id = ?",
        )
        .run("completed", now, connection.id, session.id);
    })();
    return { session: this.getSession(session.id)!, connection };
  }

  markBrowserOpened(sessionId: string): BrowserConnectionSession {
    const session = this.getSession(sessionId);
    if (!session) throw new Error("Browser connection session not found");
    if (session.status !== "awaiting_user")
      throw new Error(`Connection session is ${session.status}`);
    this.db
      .prepare("UPDATE browser_connection_sessions SET status = ? WHERE id = ?")
      .run("browser_opened", sessionId);
    return this.getSession(sessionId)!;
  }

  validate(id: string): PlatformConnection {
    const connection = this.getConnection(id);
    if (!connection) throw new Error("Platform connection not found");
    const info = descriptor(connection.provider);
    const now = new Date().toISOString();
    const status: ConnectionStatus =
      info.implementation === "ready" ? "connected" : "needs_validation";
    const healthMessage =
      info.implementation === "ready"
        ? "Read-only validation passed."
        : "No production adapter is enabled for this provider yet; external actions remain blocked.";
    this.db
      .prepare(
        "UPDATE platform_connections SET status = ?, last_validated_at = ?, updated_at = ?, health_message = ? WHERE id = ?",
      )
      .run(status, now, now, healthMessage, id);
    return this.getConnection(id)!;
  }

  revoke(id: string): PlatformConnection {
    const connection = this.getConnection(id);
    if (!connection) throw new Error("Platform connection not found");
    const now = new Date().toISOString();
    const credentialRef = connection.credentialRef;
    this.db
      .prepare(
        "UPDATE platform_connections SET status = ?, credential_ref = NULL, updated_at = ?, health_message = ? WHERE id = ?",
      )
      .run(
        "revoked",
        now,
        "Connection revoked locally. Revoke provider-side access in the official console if required.",
        id,
      );
    if (credentialRef?.startsWith("platform/")) {
      try {
        this.credentialVault?.delete(credentialRef);
      } catch {
        // The connection is still revoked and the metadata reference is removed;
        // a vault health check can report any storage cleanup failure separately.
      }
    }
    return this.getConnection(id)!;
  }
}

export function listPlatformDescriptors(): PlatformDescriptor[] {
  return PROVIDERS.map((provider) => ({
    ...provider,
    capabilities: provider.capabilities.map((capability) => ({
      ...capability,
    })),
    requiredScopes: [...provider.requiredScopes],
    setupSteps: [...provider.setupSteps],
  }));
}

export function isSupportedPlatformProvider(
  value: unknown,
): value is PlatformProvider {
  return (
    typeof value === "string" &&
    PROVIDERS.some((provider) => provider.id === value)
  );
}

export function getPlatformDescriptor(
  provider: PlatformProvider,
): PlatformDescriptor {
  return descriptor(provider);
}
