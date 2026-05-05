// ---------------------------------------------------------------------------
// Configurable field / status mappings
// No field names or status values are hardcoded here — those come from
// the user's config file so the package adapts to any Bitable schema.
// ---------------------------------------------------------------------------

// ---- Field mappings -----------------------------------------------------

export interface TicketFieldMapping {
  status: string;
  owner: string;
  ownerLeaseAt: string;
  retryCount: string;
  summary: string;
  keyfacts: string;
  rootMsgId: string;
  chatId: string;
  senderId: string;
  requiredCapabilities: string;
  result: string;
  conversationId: string;
  approvers: string;
  createdAt: string;
  updatedAt: string;
}

export interface TurnFieldMapping {
  ticketRecordId: string;
  rootMsgId: string;
  role: string;
  content: string;
  status: string;
  dedupKey: string;
  agentIdentity: string;
  human: string;
  deliveryOwner: string;
  deliveryLeaseAt: string;
  createdAt: string;
  notified: string;
  updatedAt: string;
}

export interface RosterFieldMapping {
  identity: string;
  nickname: string;
  role: string;
  channelType: string;
  hostname: string;
  user: string;
  pid: string;
  lastSeenAt: string;
  registeredAt: string;
  capabilities: string;
  human: string;
  createdAt: string;
  updatedAt: string;
}

export interface FieldMapping {
  ticket: TicketFieldMapping;
  turn: TurnFieldMapping;
  roster: RosterFieldMapping;
}

// ---- Status mappings ----------------------------------------------------

export interface StatusMapping {
  draft: string;
  pending: string;
  assigned: string;
  pendingApproval: string;
  done: string;
  failed: string;
  closed: string;
}

// ---- Auth ----------------------------------------------------------------

/** What kind of credentials are available */
export type AuthMode = 'oauth' | 'app_secret' | 'none';

export interface TokenProvider {
  getToken(): Promise<string>;
}

export interface StoredTokens {
  refreshToken: string;
  accessToken: string;
  expiresAt: number;      // epoch ms
  scope?: string;
  userId?: string;         // open_id from OAuth response
  userName?: string;       // display name from OAuth response
  openApiDomain?: string;  // the open API host when this token was created
}

// ---- Config -------------------------------------------------------------

export interface ChannelConfig {
  enabled: boolean;
  useLLM: boolean;
  draftTTLMinutes: number;
  pollIntervalSeconds: number;
  llmArgs?: string[];
  /** Capabilities mapping method. 'command'=slash command, 'keyword'=keyword match. */
  capabilitiesMapping?: 'command' | 'keyword';
}

export interface ExecutorConfig {
  capabilities: string[];
  skipApproval?: boolean;
  approvalTimeoutMinutes?: number;
  postReview?: boolean;
}

export interface Config {
  appId: string;
  appSecret?: string;        // optional — PKCE mode doesn't need it
  openApiDomain?: string;    // e.g. "open.feishu.cn" or "open.larksuite.com"
  appToken: string;
  ticketsTableId: string;
  turnsTableId: string;
  rosterTableId: string;
  /** Optional — capabilities whitelist table for keyword-based classification. */
  capabilitiesWhitelistTableId?: string;
  /** Optional — owner's Feishu open_id, written to Roster.human on register. */
  ownerOpenId?: string;
  fields: FieldMapping;
  statuses: StatusMapping;
  identity: string;
  nickname: string;
  peakInterval: number;
  offPeakInterval: number;
  nightInterval: number;
  leaseDuration: number;
  claudeTimeout: number;
  claudeArgs: string[];
  maxRetries: number;
  /** System prompt content (embedded in config, not a file path). */
  prompt: string;
  maxConcurrency: number;
  /** Channel sub-config (replaces Operator) */
  channel?: ChannelConfig;
  /** Executor sub-config */
  executor?: ExecutorConfig;
}

// ---- Bitable record -----------------------------------------------------

export interface BitableRecord<T = Record<string, unknown>> {
  record_id: string;
  fields: T;
}

// ---- Process ------------------------------------------------------------

export interface ProcessContext {
  ticket: BitableRecord;
  turns: BitableRecord[];
  config: Config;
}

export interface ProcessResult {
  answer: string;
  newSummary: string;
  newKeyfacts: Record<string, string>;
}

export interface CompletenessCheckResult {
  isComplete: boolean;
  summary: string;
  missingFields: string[];
  requiredCapabilities: string[];
}

export interface Processor {
  process(ctx: ProcessContext): Promise<ProcessResult | null>;
}
