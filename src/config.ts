import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { Config, FieldMapping, StatusMapping, ChannelConfig, ExecutorConfig } from './types.js';

// ---------------------------------------------------------------------------
// Profile path
// ---------------------------------------------------------------------------

const PROFILES_DIR = join(homedir(), '.bitable-mesh', 'profiles');
const CACHE_DIR = join(homedir(), '.cache', 'bitable-mesh');

export function profilePath(name: string): string {
  return join(PROFILES_DIR, `${name}.toml`);
}

export function logDir(): string {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  return CACHE_DIR;
}

// ---------------------------------------------------------------------------
// Minimal dotenv loader (zero dependencies)
// ---------------------------------------------------------------------------

function loadEnvFile(path: string): void {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const raw of content.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch { /* .env file is optional */ }
}

const g = (k: string, fallback = ''): string => process.env[k] ?? fallback;

// ---------------------------------------------------------------------------
// Random nickname generator
// ---------------------------------------------------------------------------

function randomNickname(): string {
  const prefixes = [
    'astral', 'cosmic', 'eclipse', 'nebula', 'orbit', 'solar',
    'stellar', 'lunar', 'aurora', 'comet', 'pulsar', 'quasar',
    'nova', 'deep', 'hyper', 'quantum', 'warp', 'flux',
  ];
  const suffixes = [
    'beacon', 'crusader', 'explorer', 'galaxy', 'horizon',
    'meteor', 'pioneer', 'rover', 'satellite', 'voyager',
    'helix', 'vector', 'compass', 'zenith', 'nexus',
  ];
  return `${prefixes[Math.floor(Math.random() * prefixes.length)]}-${suffixes[Math.floor(Math.random() * suffixes.length)]}-${Math.floor(Math.random() * 90) + 10}`;
}

// ---------------------------------------------------------------------------
// Sensible defaults for field / status mappings
// ---------------------------------------------------------------------------

const DEFAULT_FIELDS: FieldMapping = {
  ticket: {
    status: 'status',
    owner: 'owner',
    ownerLeaseAt: 'owner_lease_at',
    retryCount: 'retry_count',
    summary: 'summary',
    keyfacts: 'keyfacts',
    rootMsgId: 'root_msg_id',
    chatId: 'chat_id',
    senderId: 'sender_id',
    requiredCapabilities: 'required_capabilities',
    result: 'result',
    conversationId: 'conversation_id',
    approvers: 'approvers',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
  turn: {
    ticketRecordId: 'ticket_record_id',
    rootMsgId: 'root_msg_id',
    role: 'role',
    content: 'content',
    status: 'turn_status',
    dedupKey: 'dedup_key',
    agentIdentity: 'agent_identity',
    human: 'human',
    deliveryOwner: 'delivery_owner',
    deliveryLeaseAt: 'delivery_lease_at',
    createdAt: 'created_at',
    notified: 'notified',
    updatedAt: 'updated_at',
  },
  roster: {
    identity: 'identity',
    nickname: 'nickname',
    role: 'role',
    channelType: 'channel_type',
    hostname: 'hostname',
    user: 'user',
    pid: 'pid',
    lastSeenAt: 'last_seen_at',
    registeredAt: 'registered_at',
    capabilities: 'capabilities',
    human: 'human',
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  },
};

const DEFAULT_STATUSES: StatusMapping = {
  draft: 'draft',
  pending: 'pending',
  assigned: 'assigned',
  pendingApproval: 'pending_approval',
  done: 'done',
  failed: 'failed',
  closed: 'closed',
};

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadTOML(path: string): Record<string, unknown> {
  return parseToml(readFileSync(path, 'utf-8')) as Record<string, unknown>;
}

/** Get the raw record from a TOML profile file. Returns null if not found. */
export function readProfile(name: string): Record<string, unknown> | null {
  const path = profilePath(name);
  if (!existsSync(path)) return null;
  try {
    return loadTOML(path);
  } catch {
    return null;
  }
}

/** Save a record to a TOML profile file. */
export function saveProfile(name: string, data: Record<string, unknown>): void {
  if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true, mode: 0o700 });
  const out: Record<string, unknown> = {};
  // Order top-level keys sensibly
  const topKeys = ['appId', 'identity', 'nickname', 'openApiDomain', 'appToken',
    'ticketsTableId', 'turnsTableId', 'rosterTableId', 'capabilitiesWhitelistTableId',
    'ownerOpenId', 'peakInterval', 'offPeakInterval', 'nightInterval', 'leaseDuration',
    'claudeTimeout', 'maxRetries', 'prompt'];
  for (const k of topKeys) if (k in data) out[k] = data[k];
  // sub-tables
  for (const k of ['fields', 'statuses', 'channel', 'executor']) {
    if (data[k]) out[k] = data[k];
  }
  // any remaining keys
  for (const k of Object.keys(data)) {
    if (!(k in out)) out[k] = data[k];
  }
  const toml = stringifyToml(out);
  writeFileSync(profilePath(name), toml + '\n', { mode: 0o600 });
}

/** List available profile names (without .toml extension). */
export function listProfiles(): string[] {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter((f: string) => f.endsWith('.toml'))
    .map((f: string) => f.slice(0, -5));
}

export function loadConfig(profile = 'default'): Config {
  // 1. Load .env from ~/.bitable-mesh/ and CWD
  for (const dir of [join(homedir(), '.bitable-mesh'), process.cwd()]) {
    const p = join(dir, '.env');
    if (existsSync(p)) { loadEnvFile(p); break; }
  }

  // 2. Load profile TOML
  const path = profilePath(profile);
  const raw = existsSync(path) ? loadTOML(path) : {};

  // 3. Merge field mappings
  const rawFields = raw.fields as Record<string, any> | undefined;
  const fields: FieldMapping = {
    ticket: { ...DEFAULT_FIELDS.ticket, ...rawFields?.ticket },
    turn: { ...DEFAULT_FIELDS.turn, ...rawFields?.turn },
    roster: { ...DEFAULT_FIELDS.roster, ...rawFields?.roster },
  };
  const statuses: StatusMapping = { ...DEFAULT_STATUSES, ...(raw.statuses as Partial<StatusMapping>) };

  // 4. Channel sub-config
  const rawChannel = raw.channel as Record<string, any> | undefined;
  const channel: ChannelConfig = {
    enabled: rawChannel?.enabled ?? true,
    useLLM: rawChannel?.useLLM ?? false,
    draftTTLMinutes: Number(rawChannel?.draftTTLMinutes ?? 60),
    pollIntervalSeconds: Number(rawChannel?.pollIntervalSeconds ?? 3),
    llmArgs: rawChannel?.llmArgs,
    capabilitiesMapping: (rawChannel?.capabilitiesMapping as 'command' | 'keyword') ?? 'keyword',
  };

  // 5. Executor sub-config
  const rawExecutor = raw.executor as Record<string, any> | undefined;
  const executor: ExecutorConfig = {
    capabilities: Array.isArray(rawExecutor?.capabilities) ? rawExecutor.capabilities as string[] : [],
    skipApproval: rawExecutor?.skipApproval === true,
    approvalTimeoutMinutes: Number(rawExecutor?.approvalTimeoutMinutes ?? 30),
    postReview: rawExecutor?.postReview === true,
  };

  // 6. Identity
  const identity = String(raw.identity ?? '') || `${hostname()}-${process.env.USER ?? 'unknown'}`;
  const nickname = String(raw.nickname ?? '') || randomNickname();

  return {
    appId: String(raw.appId ?? ''),
    appSecret: String(raw.appSecret ?? '') || g('BITABLE_APP_SECRET') || undefined,
    openApiDomain: String(raw.openApiDomain ?? '') || undefined,
    appToken: String(raw.appToken ?? ''),
    ticketsTableId: String(raw.ticketsTableId ?? ''),
    turnsTableId: String(raw.turnsTableId ?? ''),
    rosterTableId: String(raw.rosterTableId ?? ''),
    capabilitiesWhitelistTableId: String(raw.capabilitiesWhitelistTableId ?? '') || undefined,
    ownerOpenId: String(raw.ownerOpenId ?? '') || g('OWNER_OPEN_ID') || undefined,
    fields,
    statuses,
    identity,
    nickname,
    peakInterval: Number(raw.peakInterval ?? 3),
    offPeakInterval: Number(raw.offPeakInterval ?? 30),
    nightInterval: Number(raw.nightInterval ?? 300),
    leaseDuration: Number(raw.leaseDuration ?? 300),
    claudeTimeout: Number(raw.claudeTimeout ?? 600),
    claudeArgs: ['--dangerously-skip-permissions'],
    maxRetries: Number(raw.maxRetries ?? 3),
    prompt: String(raw.prompt ?? ''),
    maxConcurrency: Number(raw.maxConcurrency ?? 5),
    channel,
    executor,
  };
}

export function validateConfig(cfg: Config): void {
  const errors: string[] = [];

  if (!cfg.appId) errors.push('appId');
  if (!cfg.appToken) errors.push('appToken');
  if (!cfg.ticketsTableId) errors.push('ticketsTableId');
  if (!cfg.turnsTableId) errors.push('turnsTableId');
  if (!cfg.rosterTableId) errors.push('rosterTableId');

  if (errors.length) {
    console.error(`Config errors: ${errors.join(', ')}`);
    console.error('Run `bitable-mesh setup` to create a profile.');
    process.exit(1);
  }
}
