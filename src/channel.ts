import { spawn } from 'node:child_process';
import { Client, WSClient, EventDispatcher } from '@larksuiteoapi/node-sdk';
import { Config, BitableRecord, CompletenessCheckResult } from './types.js';
import { BitableClient } from './bitable.js';
import { Session, extractText, extractUserIds } from './protocol.js';
import { ClaudeProcessor } from './processor.js';
import { getDomainConfig } from './domain.js';

const DEFAULT_EMOJI = 'OnIt';

const CLARIFY_QUESTION =
  '请问可以详细描述您遇到的问题吗？如果有相关的订单号、错误信息，也请一并提供，我会帮您排查。';

const COMPLETENESS_PROMPT = `Analyze the support ticket and conversation below. Determine if the user has provided enough information for a technical support agent to investigate.

Respond in JSON only:
{
  "isComplete": true/false,
  "summary": "concise summary of the issue",
  "missingFields": ["list", "of", "missing", "info"],
  "requiredCapabilities": ["capability1", "capability2"]
}`;

// ---------------------------------------------------------------------------
// Channel — Feishu IM communication only.
//
// Responsibilities:
//   1. Receive user DMs via WebSocket
//   2. Create draft topics and gather info (multi-turn if needed)
//   3. Optionally use LLM to assess completeness
//   4. Promote drafts to pending for executors
//   5. Poll for done topics and notify users via IM thread reply
//   6. Clean up stale draft topics
//
// Never executes tasks or sends IM on behalf of executors — that's the
// executor's job (writing results).
// ---------------------------------------------------------------------------

export class Channel {
  private wsClient: WSClient | null = null;
  private bitable: BitableClient;
  private session: Session;
  private processor: ClaudeProcessor;
  private client: Client;
  private running = true;
  private draftCleanupTimer: ReturnType<typeof setInterval> | null = null;
  /** Delivered turn IDs (in-memory dedup to tolerate markTurnNotified() failures). */
  private deliveredTurnIds = new Set<string>();
  constructor(private cfg: Config) {
    this.bitable = new BitableClient(cfg);
    this.session = new Session(cfg.identity, cfg.nickname, cfg, this.bitable);
    this.processor = new ClaudeProcessor(cfg);
    const dc = getDomainConfig(cfg.openApiDomain);
    this.client = new Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret || 'unused',
      domain: dc.sdkBaseUrl,
    });
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => { this.stop(); process.exit(0); });
    process.on('SIGINT', () => { this.stop(); process.exit(0); });

    await this.session.register();
    console.log(`[channel] started identity=${this.cfg.identity} nickname=${this.cfg.nickname}`);

    await this.connectWebSocket();

    // Draft TTL cleanup
    const ttlMs = (this.cfg.channel?.draftTTLMinutes ?? 60) * 60 * 1000;
    this.draftCleanupTimer = setInterval(() => this.cleanupStaleDrafts(ttlMs), ttlMs);

    while (this.running) {
      await sleep((this.cfg.channel?.pollIntervalSeconds ?? 3) * 1000);
      try {
        await this.session.heartbeat();
        await this.deliverTurns();
      } catch { /* ignore */ }
    }

    this.cleanup();
    console.log('[channel] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
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
      console.log('[channel] appSecret required for WebSocket event subscription.');
      return;
    }

    try {
      const dc = getDomainConfig(this.cfg.openApiDomain);
      this.wsClient = new WSClient({
        appId: this.cfg.appId,
        appSecret: this.cfg.appSecret,
        domain: dc.sdkBaseUrl,
        autoReconnect: true,
        onReady: () => console.log('[channel] WS connected'),
        onError: (err) => console.error(`[channel] WS error: ${err.message}`),
        onReconnecting: () => console.log('[channel] WS reconnecting...'),
        onReconnected: () => console.log('[channel] WS reconnected'),
      });

      const dispatcher = new EventDispatcher({});
      dispatcher.register({
        'im.message.receive_v1': async (data) => { await this.onBotMessage(data); },
      });

      await this.wsClient.start({ eventDispatcher: dispatcher });
    } catch (err: any) {
      console.warn(`[channel] WS init failed: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Message handler
  // -----------------------------------------------------------------------

  private async onBotMessage(raw: any): Promise<void> {
    const data = raw.event ?? raw;
    console.log(`[channel] im.message event: type=${data.message?.message_type} chat=${data.message?.chat_type}`);

    const msg = data.message;
    if (!msg) return;

    // Only messages from real users
    if (data.sender?.sender_type !== 'user') return;

    // In group chat, Feishu only delivers messages where the bot is @mentioned.
    // Verify mentions are present to be safe.
    if (msg.chat_type === 'group') {
      if (!msg.mentions || msg.mentions.length === 0) return;
    } else if (msg.chat_type !== 'p2p') {
      return; // unsupported chat type
    }

    // Parse content — support text, post (rich text), and interactive (card) messages
    let content: string;
    if (msg.message_type === 'post') {
      try {
        const parsed = JSON.parse(msg.content);
        console.log(`[channel] post raw=${msg.content}`);
        content = extractPostText(parsed);
        if (!content) console.log(`[channel] post content empty, raw=${JSON.stringify(parsed).slice(0, 300)}`);
      } catch (err) {
        console.log(`[channel] post parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'interactive') {
      try {
        content = extractCardText(JSON.parse(msg.content));
      } catch (err) {
        console.log(`[channel] interactive parse failed raw=${String(msg.content).slice(0, 300)} err=${(err as Error).message}`);
        content = '';
      }
    } else if (msg.message_type === 'text') {
      try { content = JSON.parse(msg.content).text ?? msg.content; } catch { content = msg.content; }
      // Strip mention markers (@_user_N) from group chat messages
      content = content.replace(/@_user_\d+/g, '').trim();
    } else {
      return; // unsupported message type
    }
    if (!content) return;

    // If this message is a reply to another message, fetch the parent's text
    // and prepend it as a quote so the executor has full context.
    if (msg.parent_id) {
      try {
        const parentText = await this.fetchMessageText(msg.parent_id);
        if (parentText) {
          content = `> ${parentText.replace(/\n/g, '\n> ')}\n\n${content}`;
        }
      } catch (err) {
        console.log(`[channel] fetch parent message failed id=${msg.parent_id.slice(0, 12)} err=${(err as Error).message}`);
      }
    }

    const messageId = msg.message_id;
    if (!messageId) return;

    const senderId = data.sender.sender_id?.open_id ?? 'unknown';
    const chatId = msg.chat_id;
    const rootId = msg.root_id;

    console.log(`[channel] DM from ${senderId}: ${content.slice(0, 80)}`);

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
        console.log(`[channel] message ${messageId.slice(0, 12)} already processed`);
        return;
      }
    } catch { /* best effort */ }

    // --- Thread reply ────────────────────────────────────────────────

    if (rootId) {
      const ticket = await this.session.findByThreadRoot(rootId);
      if (!ticket || !ticket.record_id) {
        console.log('[channel] thread root not found, creating new ticket');
      } else {
        console.log(`[channel] thread reply → ticket ${ticket.record_id.slice(0, 12)}`);
        await this.handleThreadReply(ticket, content, messageId, senderId);
        return;
      }
    }

    // --- New conversation ────────────────────────────────────────────

    // Classify capabilities before creating ticket
    const { capability, cleanedContent } = await this.classifyCapabilities(content);

    try {
      const ticket = await this.session.createTicket(cleanedContent || content, {
        rootMsgId: messageId,
        chatId,
        senderId,
      });

      // Store classified capability for use in processDraft
      (ticket as any).__capability = capability;

      await this.bitable.createRecord(this.cfg.turnsTableId, {
        [this.cfg.fields.turn.ticketRecordId]: ticket.record_id,
        [this.cfg.fields.turn.rootMsgId]: messageId,
        [this.cfg.fields.turn.role]: 'user',
        [this.cfg.fields.turn.content]: content,
        [this.cfg.fields.turn.dedupKey]: messageId,
        [this.cfg.fields.turn.agentIdentity]: senderId,
        [this.cfg.fields.turn.createdAt]: Date.now(),
      });

      await this.processDraft(ticket, content, messageId, chatId);
    } catch (err) {
      console.error('[channel] failed to create ticket:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Draft processing
  // -----------------------------------------------------------------------

  private async handleThreadReply(
    ticket: BitableRecord,
    content: string,
    messageId: string,
    senderId: string,
  ): Promise<void> {
    const recordId = ticket.record_id!;
    const status = String(ticket.fields[this.cfg.fields.ticket.status] ?? '');
    const chatId = String(ticket.fields[this.cfg.fields.ticket.chatId] ?? '');

    // Append the user turn
    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    await this.bitable.createRecord(this.cfg.turnsTableId, {
      [this.cfg.fields.turn.ticketRecordId]: recordId,
      [this.cfg.fields.turn.rootMsgId]: rootMsgId,
      [this.cfg.fields.turn.role]: 'user',
      [this.cfg.fields.turn.content]: content,
      [this.cfg.fields.turn.dedupKey]: messageId,
      [this.cfg.fields.turn.agentIdentity]: senderId,
      [this.cfg.fields.turn.createdAt]: Date.now(),
    });

    // Draft → re-evaluate completeness
    if (status === this.cfg.statuses.draft) {
      await this.processDraft(ticket, content, messageId, chatId);
      return;
    }

    // Pending/assigned — executor will pick up
    if (status === this.cfg.statuses.pending || status === this.cfg.statuses.assigned) {
      return;
    }

    // Done — reopen silently
    if (status === this.cfg.statuses.done) {
      await this.session.promoteToPending(recordId, content);
      return;
    }

    // Failed — reactivate on user reply
    if (status === this.cfg.statuses.failed) {
      await this.bitable.updateRecord(this.cfg.ticketsTableId, recordId, {
        [this.cfg.fields.ticket.status]: this.cfg.statuses.pending,
        [this.cfg.fields.ticket.retryCount]: 0,
        [this.cfg.fields.ticket.owner]: '',
        [this.cfg.fields.ticket.ownerLeaseAt]: 0,
      });
      await this.reply(messageId, `已重新激活工单，正在排队处理`, true);
      return;
    }
  }

  private async processDraft(
    ticket: BitableRecord,
    content: string,
    messageId: string,
    _chatId: string,
  ): Promise<void> {
    // Collect classified capability from ticket metadata
    const classifiedCap: string | undefined = (ticket as any).__capability;

    if (this.cfg.channel?.useLLM) {
      // LLM-based completeness check
      const result = await this.checkCompleteness(ticket);
      if (result?.isComplete) {
        // Merge classified capability with LLM-identified capabilities
        const caps = [
          ...(classifiedCap ? [classifiedCap] : []),
          ...(result.requiredCapabilities || []),
        ];
        await this.session.promoteToPending(
          ticket.record_id!,
          result.summary || content,
          caps.length > 0 ? caps : undefined,
        );
        console.log(`[channel] ticket ${ticket.record_id!.slice(0, 12)} promoted to pending`);
      } else {
        await this.reply(messageId, CLARIFY_QUESTION, true);
        console.log(`[channel] clarification asked for ${ticket.record_id!.slice(0, 12)}`);
      }
    } else {
      // No LLM — promote directly, classified capability as requiredCapabilities
      const caps = classifiedCap ? [classifiedCap] : undefined;
      await this.session.promoteToPending(ticket.record_id!, content, caps);
      console.log(`[channel] ticket ${ticket.record_id!.slice(0, 12)} promoted to pending`);
    }
  }

  // -----------------------------------------------------------------------
  // LLM completeness check
  // -----------------------------------------------------------------------

  private async checkCompleteness(ticket: BitableRecord): Promise<CompletenessCheckResult | null> {
    try {
      const recordId = ticket.record_id!;
      const turns = await this.session.getTurns(recordId);
      const fields = ticket.fields;
      const tf = this.cfg.fields.ticket;

      const prompt = [
        COMPLETENESS_PROMPT,
        '',
        `Summary: ${String(fields[tf.summary] ?? '')}`,
        'Conversation:',
        ...turns.map((t) => `[${t.fields[this.cfg.fields.turn.role]}]\n${t.fields[this.cfg.fields.turn.content]}`),
      ].join('\n');

      const args = this.cfg.channel?.llmArgs ?? this.cfg.claudeArgs;
      const result = await this.runClaudeJSON(prompt, args);
      if (!result) return null;

      return {
        isComplete: Boolean(result.isComplete),
        summary: String(result.summary ?? ''),
        missingFields: Array.isArray(result.missingFields) ? result.missingFields as string[] : [],
        requiredCapabilities: Array.isArray(result.requiredCapabilities) ? result.requiredCapabilities as string[] : [],
      };
    } catch (err) {
      console.error(`[channel] checkCompleteness failed:`, err);
      return null;
    }
  }

  /** Run Claude and parse JSON output. */
  private runClaudeJSON(prompt: string, args: string[]): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      const proc = spawn('claude', ['-p', prompt, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60_000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        if (code !== 0) {
          console.error(`[channel] claude completeness exited ${code}: ${stderr.slice(0, 200)}`);
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          // Try to extract JSON block
          const match = stdout.match(/\{[\s\S]*\}/);
          if (match) {
            try { resolve(JSON.parse(match[0])); } catch { resolve(null); }
          } else {
            resolve(null);
          }
        }
      });

      proc.on('error', (err) => {
        console.error(`[channel] completeness spawn failed: ${err.message}`);
        resolve(null);
      });
    });
  }

  // -----------------------------------------------------------------------
  // Turn delivery — send ACKs, answers, and errors via IM
  // -----------------------------------------------------------------------

  private async deliverTurns(): Promise<void> {
    try {
      const turns = await this.session.searchNotifiableTurns();
      if (turns.length === 0) return;

      console.log(`[channel] deliverTurns: ${turns.length} turns to deliver`);
      for (const turn of turns) {
        if (!this.running) break;
        const turnRecordId = turn.record_id;
        if (!turnRecordId) continue;
        if (this.deliveredTurnIds.has(turnRecordId)) continue;

        // Multi-process safety: claim the turn before delivering.  The claim
        // writes deliveryOwner + deliveryLeaseAt using WSR (write-sleep-read).
        // Only the winning Channel process proceeds with IM delivery.
        const claimed = await this.session.claimTurnDelivery(turnRecordId);
        if (!claimed) {
          continue;
        }

        const content = extractText(turn.fields[this.cfg.fields.turn.content]);
        const rootMsgId = extractText(turn.fields[this.cfg.fields.turn.rootMsgId]);
        const status = String(turn.fields[this.cfg.fields.turn.status] ?? '');

        if (!content || !rootMsgId) {
          console.log(`[channel] skip turn ${turnRecordId.slice(0, 12)} (missing content/rootMsgId)`);
          continue;
        }

        // Append human CC mention if the turn carries reviewer/owner people.
        // This may be either a direct Person field or a Lookup-wrapped Person
        // field depending on how the user's Bitable schema is configured.
        const human = extractUserIds(turn.fields[this.cfg.fields.turn.human]);
        let finalContent = content;
        if (human) {
          const parts = human.split(',').map(s => s.trim()).filter(Boolean);
          const ccParts = parts.map(p =>
            p.startsWith('ou_') ? `<at id=${p}></at>` : p,
          );
          finalContent = `${content}\n\ncc ${ccParts.join(' ')}`;
        }

        try {
          await this.reply(rootMsgId, finalContent, true);
          this.deliveredTurnIds.add(turnRecordId);
          await this.session.markTurnNotified(turnRecordId);
          console.log(`[channel] delivered ${status} turn ${turnRecordId.slice(0, 12)}`);
        } catch (err) {
          console.error(`[channel] deliver turn failed ${turnRecordId.slice(0, 12)}:`, err);
        }
      }
    } catch (err) {
      console.error('[channel] deliverTurns error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Draft TTL cleanup
  // -----------------------------------------------------------------------

  private async cleanupStaleDrafts(maxAgeMs: number): Promise<void> {
    try {
      const drafts = await this.bitable.searchRecords(this.cfg.ticketsTableId, {
        conjunction: 'and',
        conditions: [
          { field_name: this.cfg.fields.ticket.status, operator: 'is', value: [this.cfg.statuses.draft] },
        ],
      });

      const cutoff = Date.now() - maxAgeMs;
      const tf = this.cfg.fields.ticket;
      let closed = 0;

      for (const d of drafts) {
        const createdAt = Number(d.fields[tf.createdAt] ?? 0) || Date.now();
        if (createdAt < cutoff) {
          await this.bitable.updateRecord(this.cfg.ticketsTableId, d.record_id!, {
            [tf.status]: this.cfg.statuses.closed,
          });
          closed++;
        }
      }

      if (closed > 0) console.log(`[channel] closed ${closed} stale draft(s)`);

      // Prevent unbounded growth of the delivered-turn dedup set
      if (this.deliveredTurnIds.size > 10_000) {
        this.deliveredTurnIds.clear();
        console.log('[channel] cleared deliveredTurnIds set');
      }
    } catch (err) {
      console.error('[channel] cleanupStaleDrafts error:', err);
    }
  }

  // -----------------------------------------------------------------------
  // Capabilities classification
  // -----------------------------------------------------------------------

  /** Classify user message to a capability.
   *
   *  Method 1 (command): if message starts with `/tech_support`, etc.
   *    The prefix is stripped from the returned content.
   *
   *  Method 2 (keyword): fetch the capabilities whitelist table, match
   *    keywords from each row's description field against the message.
   *
   *  Falls back to undefined if no match. */
  private async classifyCapabilities(content: string): Promise<{
    capability?: string;
    cleanedContent: string;
  }> {
    const method = this.cfg.channel?.capabilitiesMapping ?? 'keyword';

    // -- Method 1: slash command ───────────────────────────────────────
    const cmdMatch = content.match(/^\/([a-z][a-z0-9_]*)\s*(.*)/s);
    if (cmdMatch) {
      const capability = cmdMatch[1];
      const rest = cmdMatch[2] || '';
      if (rest.trim()) {
        return { capability, cleanedContent: rest };
      }
      return { capability, cleanedContent: content };
    }

    // -- Method 2: keyword matching ────────────────────────────────────
    if (method === 'keyword' && this.cfg.capabilitiesWhitelistTableId) {
      try {
        const whitelist = await this.bitable.searchRecords(this.cfg.capabilitiesWhitelistTableId, {
          conjunction: 'and',
          conditions: [
            { field_name: 'enabled', operator: 'is', value: [true] },
          ],
        });
        if (whitelist.length > 0) {
          const lower = content.toLowerCase();
          let bestScore = 0;
          let bestCapability: string | undefined;
          for (const row of whitelist) {
            const cap = extractText(row.fields['capability']);
            const keywords = extractText(row.fields['description'] ?? row.fields['keywords'] ?? '');
            if (!cap) continue;
            const kwList = keywords.split(/[,，]/).filter(Boolean);
            const score = kwList.filter((k) => lower.includes(k.trim().toLowerCase())).length;
            if (score > bestScore) {
              bestScore = score;
              bestCapability = cap;
            }
          }
          if (bestCapability) return { capability: bestCapability, cleanedContent: content };
          const general = whitelist.find((r) => extractText(r.fields['capability']) === 'general');
          if (general) return { capability: 'general', cleanedContent: content };
        }
      } catch { /* table not ready — skip */ }
    }

    return { cleanedContent: content };
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

  /** Reply to a message, optionally in thread mode, using Card JSON 2.0 markdown. */
  private async reply(messageId: string, text: string, replyInThread?: boolean): Promise<void> {
    if (!text.trim()) return;

    const card = {
      schema: '2.0',
      body: {
        elements: [
          { tag: 'markdown', content: text },
        ],
      },
    };

    await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify(card),
        reply_in_thread: replyInThread,
      } as any,
    });
  }

  /** Fetch a message by ID and extract its text content for context quoting. */
  private async fetchMessageText(messageId: string): Promise<string> {
    const resp: any = await this.client.im.v1.message.get({
      path: { message_id: messageId },
    });
    const msg = resp?.data?.items?.[0];
    if (!msg?.msg_type || !msg?.body?.content) return '';
    return parseMessageContent(msg.msg_type, msg.body.content);
  }

  private cleanup(): void {
    if (this.draftCleanupTimer) clearInterval(this.draftCleanupTimer);
    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Convert Feishu post (rich text) message content to Markdown.
 *
 * Post structure (standard format):
 *   { title, content: [[{tag, text, ...}, ...], ...] }
 * Or wrapped in language key:
 *   { zh_cn: { title, content: [[...]] } }
 *
 * There is no native list/ordered tag — list appearance is simulated with
 * "- " or "1. " prefixes in text content. Each outer array element is one
 * paragraph. Inline elements: text, a (link), at (mention), img.
 *
 * Reference: https://open.feishu.cn/document/ukTMukTMukTM/uMDMxEjLzATMx4yMwETM
 */
function extractPostText(data: Record<string, any>): string {
  // Resolve language wrapper if present
  const section = data.content ? data : (data.zh_cn ?? data.en_us ?? Object.values(data)[0]);
  if (!section?.content) return '';

  const lines: string[] = [];

  for (const paragraph of section.content) {
    if (!Array.isArray(paragraph) || paragraph.length === 0) {
      lines.push('');
      continue;
    }

    // Separate inline elements with newlines — Feishu flattens lists into
    // separate text elements within one paragraph, so each element was
    // originally on its own line. Join with \n to restore readability.
    const parts = paragraph.map((inline: any) => convertInline(inline));
    lines.push(parts.filter(Boolean).join('\n'));
  }

  return lines.join('\n\n').trim();
}

/** Convert a single post inline element to Markdown text.
 *
 * Note: When receiving post messages, Feishu already converts markdown syntax
 * into element+style format (e.g. **bold** becomes style:["bold"]). Lists and
 * blockquotes are flattened to plain text. The md tag is write-only and never
 * appears in received messages.
 */
function convertInline(inline: Record<string, any>): string {
  const tag = inline.tag;

  if (tag === 'text') {
    let text = inline.text ?? '';
    const styles: string[] = inline.style ?? [];
    if (styles.includes('bold')) text = `**${text}**`;
    if (styles.includes('italic')) text = `*${text}*`;
    if (styles.includes('code')) text = `\`${text}\``;
    if (styles.includes('strikethrough')) text = `~~${text}~~`;
    return text;
  }

  if (tag === 'a') {
    const href = inline.href ?? '';
    const text = inline.text ?? href;
    return href ? `[${text}](${href})` : text;
  }

  if (tag === 'at') {
    const name = inline.user_name ?? '';
    return name ? `@${name}` : '@user';
  }

  if (tag === 'img') {
    return inline.image_key ? `![image](${inline.image_key})` : '';
  }

  return '';
}

/**
 * Extract plain text/markdown from Feishu interactive (card) message content.
 *
 * JSON 2.0: { body: { elements: [{ tag: "markdown", content: "..." }] } }
 * Legacy:   { elements: [{ tag: "div", text: { tag: "lark_md", content } }] }
 * Rich-text component (tag: "rich_text"): { elements: [{ tag: "text_run", text: "..." }] }
 */
function extractCardText(data: Record<string, any>): string {
  // Locate the elements array — differs between JSON 2.0 and legacy format
  const elements: any[] = data.body?.elements ?? data.elements ?? [];
  if (elements.length === 0) return '';

  const parts: string[] = [];

  for (const el of elements) {
    if (el.tag === 'markdown') {
      // Direct markdown content
      if (el.content) parts.push(el.content);
    } else if (el.tag === 'div' && el.text) {
      // Legacy div container with lark_md or plain_text
      if (el.text.content) parts.push(el.text.content);
    } else if (el.tag === 'rich_text' && el.elements) {
      // Rich-text component with fine-grained elements
      let line = '';
      for (const re of el.elements) {
        line += convertRichTextElement(re);
      }
      if (line) parts.push(line);
    } else if (el.tag === 'note' && el.elements) {
      // Card footer note — text_run, link, mention
      let line = '';
      for (const ne of el.elements) line += convertRichTextElement(ne);
      if (line) parts.push(line);
    } else if (el.tag === 'hr') {
      parts.push('---');
    }
  }

  return parts.join('\n\n').trim();
}

/** Convert a single rich-text element (card component) to markdown. */
function convertRichTextElement(el: Record<string, any>): string {
  if (el.tag === 'text_run') {
    let text = el.text ?? '';
    const style = el.text_element_style ?? {};
    if (style.bold) text = `**${text}**`;
    if (style.italic) text = `*${text}*`;
    if (style.strikethrough) text = `~~${text}~~`;
    if (style.code) text = `\`${text}\``;
    if (style.underline) text = `<u>${text}</u>`;
    return text;
  }

  if (el.tag === 'link') {
    const url = el.url ?? '';
    const text = el.text ?? url;
    return url ? `[${text}](${url})` : text;
  }

  if (el.tag === 'mention') {
    return `@${el.user_name ?? el.user_id ?? 'user'}`;
  }

  if (el.tag === 'emoji') {
    return el.emoji ?? '';
  }

  return '';
}

/**
 * Parse a Feishu message body.content string into readable text/markdown,
 * handling text, post, and interactive (card) message types.
 */
function parseMessageContent(msgType: string, content: string): string {
  if (msgType === 'text') {
    try { return (JSON.parse(content).text ?? content).replace(/@_user_\d+/g, '').trim(); } catch { return content; }
  }
  if (msgType === 'post') {
    try { return extractPostText(JSON.parse(content)); } catch { return ''; }
  }
  if (msgType === 'interactive') {
    try { return extractCardText(JSON.parse(content)); } catch { return ''; }
  }
  return '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
