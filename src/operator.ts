import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord } from './types.js';
import { BitableClient } from './bitable.js';
import { Session } from './protocol.js';
import { getDomainConfig } from './domain.js';

const DEFAULT_EMOJI = 'OnIt';
const CLARIFY_THRESHOLD = 15; // messages shorter than this trigger clarification

const CLARIFY_QUESTION =
  '请问可以详细描述您遇到的问题吗？如果有相关的订单号、错误信息，也请一并提供，我会帮您排查。';

// ---------------------------------------------------------------------------
// Operator — coordinator with Feishu WebSocket event subscription.
//
// Handles the pre-consultation phase:
//   1. Receives user DMs, creates tickets + turns
//   2. Assesses clarity; asks follow-up questions when needed
//   3. Holds a lease on tickets in clarification so the executor won't
//      pick them up prematurely
//   4. Releases to awaiting_agent once enough context is gathered
//
// Never runs Claude or answers questions — that's the executor's job.
// ---------------------------------------------------------------------------

export class Operator {
  private wsClient: WSClient | null = null;
  private bitable: BitableClient;
  private session: Session;
  private client: Client;
  private running = true;

  /** Set of ticket record_ids currently in clarification (lease held). */
  private clarifying = new Set<string>();

  constructor(private cfg: Config) {
    this.bitable = new BitableClient(cfg);
    this.session = new Session(cfg.identity, cfg.nickname, cfg, this.bitable);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret || 'unused',
      domain: dc.sdkBaseUrl,
    });
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    await this.session.register();
    console.log(`[operator] started identity=${this.cfg.identity} nickname=${this.cfg.nickname}`);

    await this.connectWebSocket();

    while (this.running) {
      await sleep(60_000);
      try { await this.session.heartbeat(); } catch { /* ignore */ }
    }

    this.cleanup();
    console.log('[operator] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------

  private async connectWebSocket(): Promise<void> {
    if (!this.cfg.appSecret) {
      console.log('[operator] appSecret required for WebSocket event subscription.');
      return;
    }

    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      this.wsClient = new WSClient({
        appId: this.cfg.appId,
        appSecret: this.cfg.appSecret,
        domain: dc.sdkBaseUrl,
        autoReconnect: true,
        onReady: () => console.log('[operator] WS connected'),
        onError: (err) => console.error(`[operator] WS error: ${err.message}`),
        onReconnecting: () => console.log('[operator] WS reconnecting...'),
        onReconnected: () => console.log('[operator] WS reconnected'),
      });

      const dispatcher = new EventDispatcher({});

      dispatcher.register({
        'im.message.receive_v1': async (data) => { await this.onBotMessage(data); },
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (err: any) {
      console.warn(`[operator] WS init failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Handler
  // -----------------------------------------------------------------------

  private async onBotMessage(raw: any): Promise<void> {
    const data = raw.event ?? raw;
    console.log(`[operator] im.message event: type=${data.message?.message_type} chat=${data.message?.chat_type}`);

    const msg = data.message;
    if (!msg) return;

    // Only p2p text from real users
    if (msg.chat_type !== 'p2p') return;
    if (data.sender?.sender_type !== 'user') return;
    if (msg.message_type !== 'text') return;

    // Parse text
    let content: string;
    try { content = JSON.parse(msg.content).text ?? msg.content; } catch { content = msg.content; }
    if (!content) return;

    const messageId = msg.message_id;
    if (!messageId) return;

    const senderId = data.sender.sender_id?.open_id ?? 'unknown';
    const chatId = msg.chat_id;
    const rootId = msg.root_id;

    console.log(`[operator] DM from ${senderId}: ${content.slice(0, 80)}`);

    // React with processing emoji
    try { await this.react(messageId, DEFAULT_EMOJI); } catch { /* best effort */ }

    // Dedup
    try {
      const existing = await this.bitable.searchRecords(this.cfg.turnsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.turn.dedupKey, operator: 'is', value: [messageId] },
        ],
      });
      if (existing.length > 0) {
        console.log(`[operator] message ${messageId.slice(0, 12)} already processed`);
        return;
      }
    } catch { /* best effort */ }

    // --- Thread reply ────────────────────────────────────────────────

    if (rootId) {
      const ticket = await this.session.findByThreadRoot(rootId);
      if (!ticket || !ticket.record_id) {
        console.log('[operator] thread root not found, creating new ticket');
      } else {
        console.log(`[operator] thread reply → ticket ${ticket.record_id.slice(0, 12)}`);

        // Append the user's turn
        await this.bitable.createRecord(this.cfg.turnsTableId, {
          [this.cfg.fields.turn.ticketRecordId]: ticket.record_id,
          [this.cfg.fields.turn.role]: 'user',
          [this.cfg.fields.turn.content]: content,
          [this.cfg.fields.turn.dedupKey]: messageId,
          [this.cfg.fields.turn.agentIdentity]: senderId,
          [this.cfg.fields.turn.createdAt]: Date.now(),
          [this.cfg.fields.turn.status]: 'awaiting_agent',
        });

        // If we were waiting for clarification, release the lease now
        if (this.clarifying.has(ticket.record_id)) {
          this.clarifying.delete(ticket.record_id);
          await this.releaseLease(ticket.record_id, content);
        } else {
          // Just re-open for executor
          await this.bitable.updateRecord(this.cfg.ticketsTableId, ticket.record_id, {
            [this.cfg.fields.ticket.status]: this.cfg.statuses.pending,
            [this.cfg.fields.ticket.summary]: content.slice(0, 200),
          });
        }
        return;
      }
    }

    // --- New conversation ────────────────────────────────────────────

    try {
      const ticket = await this.session.createTicket(content, {
        rootMsgId: messageId,
        chatId,
        senderId,
      });

      await this.bitable.createRecord(this.cfg.turnsTableId, {
        [this.cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [this.cfg.fields.turn.role]: 'user',
        [this.cfg.fields.turn.content]: content,
        [this.cfg.fields.turn.dedupKey]: messageId,
        [this.cfg.fields.turn.agentIdentity]: senderId,
        [this.cfg.fields.turn.createdAt]: Date.now(),
        [this.cfg.fields.turn.status]: 'awaiting_agent',
      });

      if (needsClarification(content)) {
        // Hold lease so executor doesn't pick it up
        await this.holdLease(ticket, content);
        this.clarifying.add(ticket.record_id);
        // Send clarification question in thread
        await this.sendMessage(chatId, CLARIFY_QUESTION, messageId);
        console.log(`[operator] clarification asked for ${ticket.record_id.slice(0, 12)}`);
      } else {
        // Clear enough — release immediately for executor
        await this.sendMessage(
          chatId,
          `收到，正在查看您的问题，稍后回复。（${this.cfg.nickname}）`,
          messageId,
        );
        console.log(`[operator] ticket ready: ${ticket.record_id.slice(0, 12)}`);
        // Leave as awaiting_agent for executor to pick up
      }
    } catch (err) {
      console.error('[operator] failed to create ticket:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Lease management
  // -----------------------------------------------------------------------

  /** Claim a ticket to prevent the executor from picking it up. */
  private async holdLease(ticket: BitableRecord, _reason: string): Promise<void> {
    // Use claim() to write owner + lease, then let it stay in awaiting_agent
    const recordId = ticket.record_id!;
    const ownerValue = `${this.cfg.nickname}#${this.cfg.identity}`;
    const leaseMs = Date.now() + this.cfg.leaseDuration * 1000;

    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.owner]: ownerValue,
        [this.cfg.fields.ticket.ownerLeaseAt]: leaseMs,
        // Keep status awaiting_agent so the ticket is still visible
      });
    } catch (err) {
      console.warn(`[operator] holdLease failed:`, err);
    }
  }

  /** Release the lease so the executor can pick up the ticket. */
  private async releaseLease(recordId: string, _updatedSummary: string): Promise<void> {
    // Owner guard
    const rec = await this.bitable.getRecord(this.cfg.ticketsTableId, recordId);
    if (!rec) return;
    const currentOwner = String(rec.fields[this.cfg.fields.ticket.owner] ?? '');
    if (currentOwner && !currentOwner.endsWith(`#${this.cfg.identity}`)) {
      console.log(`[operator] releaseLease: owner changed, skip ${recordId.slice(0, 12)}`);
      return;
    }

    try {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.owner]: '',
        [this.cfg.fields.ticket.ownerLeaseAt]: 0,
        [this.cfg.fields.ticket.status]: this.cfg.statuses.pending,
      });
      console.log(`[operator] released ${recordId.slice(0, 12)} to pending`);
    } catch (err) {
      console.error(`[operator] releaseLease failed ${recordId.slice(0, 12)}:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // IM helpers
  // -----------------------------------------------------------------------

  private async react(messageId: string, emojiType: string): Promise<void> {
    await this.client.im.v1.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: emojiType } },
    });
  }

  private async sendMessage(chatId: string, text: string, rootId?: string): Promise<void> {
    const data: Record<string, any> = {
      receive_id: chatId,
      msg_type: 'text',
      content: JSON.stringify({ text }),
    };
    if (rootId) data.root_id = rootId;

    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: data as any,
    });
  }

  private cleanup(): void {
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Clarity heuristics
// ---------------------------------------------------------------------------

/** Returns `true` when the user's message is too vague and needs follow-up. */
function needsClarification(text: string): boolean {
  const t = text.trim();

  // Very short messages are likely too vague
  if (t.length < CLARIFY_THRESHOLD) return true;

  // Pure greetings / chitchat
  const greetings = /^(你好|您好|hi|hello|hey|在吗|在不在|help|请问|你好吗)/i;
  if (greetings.test(t) && t.length < 40) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
