import { spawn } from 'node:child_process';
import { Config, ProcessContext, ProcessResult, Processor } from './types.js';
import { extractText } from './protocol.js';

// ---------------------------------------------------------------------------
// Claude Code subprocess processor
// ---------------------------------------------------------------------------

const FENCE_PREFIX_RE = /^```(?:json)?\s*\n?/i;
const FENCE_SUFFIX_RE = /\n?```\s*$/;

export class ClaudeProcessor implements Processor {
  private systemPrompt: string;
  private activeProc: ReturnType<typeof spawn> | null = null;

  constructor(cfg: Config) {
    if (cfg.prompt) {
      this.systemPrompt = cfg.prompt;
    } else {
      console.warn('[processor] no prompt configured, using default');
      this.systemPrompt = 'You are a technical support agent.';
    }
  }

  /** Kill the active Claude subprocess, if any. */
  abort(): void {
    if (this.activeProc) {
      try { this.activeProc.kill('SIGKILL'); } catch { /* already dead */ }
      this.activeProc = null;
    }
  }

  buildPrompt(ctx: ProcessContext): string {
    const { ticket, turns, config } = ctx;
    const fields = ticket.fields;
    const tf = config.fields.ticket;
    const nf = config.fields.turn;

    let keyfacts: Record<string, string> = {};
    try {
      keyfacts = JSON.parse(String(fields[tf.keyfacts] ?? '{}'));
    } catch { /* ignore */ }

    const conversation = turns.map((t) => `[${extractText(t.fields[nf.role])}]\n${extractText(t.fields[nf.content])}`);
    const unanswered = turns.filter((t) => extractText(t.fields[nf.role]) === 'user');

    const blocks = [
      this.systemPrompt,
      '',
      '## Ticket Context',
      `Summary: ${extractText(fields[tf.summary])}`,
      `Key Facts: ${JSON.stringify(keyfacts, null, 2)}`,
      '',
      '### Conversation',
      conversation.length ? conversation.join('\n\n') : '(暂无对话历史)',
      '',
      '### Unanswered User Messages',
      unanswered.length
        ? unanswered.map((t) => `- ${extractText(t.fields[nf.content])}`).join('\n')
        : '(all messages have been addressed)',
    ];

    return blocks.join('\n');
  }

  async process(ctx: ProcessContext): Promise<ProcessResult | null> {
    const prompt = this.buildPrompt(ctx);
    const cfg = ctx.config;

    return new Promise((resolve) => {
      const proc = spawn('claude', ['-p', prompt, ...cfg.claudeArgs], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: cfg.claudeTimeout * 1000,
      });
      this.activeProc = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on('close', (code) => {
        this.activeProc = null;
        if (code !== 0) {
          console.error(`[processor] claude exited ${code} stderr=${stderr.slice(0, 500)}`);
          resolve(null);
          return;
        }

        const parsed = parseSubAgentOutput(stdout);
        if (!parsed) {
          console.warn(`[processor] JSON parse failed, falling back to raw output stdout=${stdout.slice(0, 200)}`);
          // Return raw stdout as answer so the executor still delivers a response
          // instead of writing an error turn and marking the ticket failed.
          resolve({
            answer: stdout.trim() || '(空输出)',
            newSummary: '',
            newKeyfacts: {},
          });
          return;
        }
        resolve(parsed as unknown as ProcessResult);
      });

      proc.on('error', (err) => {
        console.error(`[processor] spawn failed: ${err.message}`);
        this.activeProc = null;
        resolve(null);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Output parser — matches prototype _parse_sub_agent_output
// ---------------------------------------------------------------------------

function parseSubAgentOutput(raw: string): Record<string, unknown> | null {
  if (!raw) return null;

  // Try direct parse
  try {
    const outer = JSON.parse(raw);
    // Handle {"type":"result","result":"{...}"} wrapper
    if (typeof outer === 'object' && outer !== null && typeof outer.result === 'string') {
      return parseInner(outer.result);
    }
    if (typeof outer === 'object' && outer !== null) return outer;
  } catch { /* fall through */ }

  return parseInner(raw);
}

/**
 * Normalize snake_case keys from Claude output to camelCase used internally.
 */
function normalizeKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const keyMap: Record<string, string> = {
    new_summary: 'newSummary',
    new_keyfacts: 'newKeyfacts',
  };
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    result[keyMap[k] ?? k] = v;
  }
  return result;
}

function parseInner(text: string): Record<string, unknown> | null {
  let cleaned = text.trim();
  cleaned = cleaned.replace(FENCE_PREFIX_RE, '');
  cleaned = cleaned.replace(FENCE_SUFFIX_RE, '').trim();

  // Try direct JSON
  try {
    return normalizeKeys(JSON.parse(cleaned));
  } catch { /* try extraction */ }

  // Find first { … } block
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}') + 1;
  if (start >= 0 && end > start) {
    const candidate = cleaned.slice(start, end);
    // Try strict parse first
    try {
      return normalizeKeys(JSON.parse(candidate));
    } catch { /* try loose parse */ }
    // Loose parse: handle literal newlines inside JSON strings (common LLM output issue)
    try {
      return normalizeKeys(JSON.parse(looseJsonClean(candidate)));
    } catch { /* try regex fallback */ }
  }

  // Final fallback: regex extraction for known fields
  return extractFields(cleaned);
}

/**
 * Clean literal newlines and other common issues from LLM-generated JSON
 * so it passes JSON.parse. Tracks string boundaries to avoid corrupting
 * legitimate escape sequences.
 */
function looseJsonClean(text: string): string {
  let result = '';
  let inString = false;
  let escapeNext = false;

  for (const ch of text) {
    if (escapeNext) {
      escapeNext = false;
      result += ch;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      result += ch;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      result += ch;
      continue;
    }
    if (inString && (ch === '\n' || ch === '\r')) {
      result += '\\n';
      continue;
    }
    result += ch;
  }

  return result;
}

/**
 * Regex-based field extraction as a last resort when JSON.parse fails entirely.
 * Uses a simplified approach: finds "key": "value" pairs with balanced-quote
 * matching for multi-line string values.
 */
function extractFields(text: string): Record<string, unknown> | null {
  const result: Record<string, unknown> = {};

  const knownKeys = ['ack', 'answer', 'newSummary', 'new_summary', 'newKeyfacts', 'new_keyfacts'];

  for (const key of knownKeys) {
    const escKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match the key and opening quote, then collect everything until an unescaped closing quote
    const re = new RegExp(`"${escKey}"\\s*:\\s*"([\\s\\S]*?)"(?=(?:\\s*[,}])|\\s*$)`, 's');
    const match = text.match(re);
    if (match) {
      let val = match[1];
      // Unescape JSON escape sequences
      val = val.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');

      if (key === 'newKeyfacts' || key === 'new_keyfacts') {
        try { result[key] = JSON.parse(val); } catch { result[key] = {}; }
      } else {
        result[key] = val;
      }
    }
  }

  // Normalize snake_case keys
  if (result.new_summary && !result.newSummary) result.newSummary = result.new_summary;
  if (result.new_keyfacts && !result.newKeyfacts) result.newKeyfacts = result.new_keyfacts;
  delete result.new_summary;
  delete result.new_keyfacts;

  if (!result.answer && !result.newSummary) return null;
  return result;
}
