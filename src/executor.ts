import { Config, BitableRecord, TokenProvider } from './types.js';
import { BitableClient } from './bitable.js';
import { Session, extractText, extractUserIds, RETRY_OWNER_PREFIX } from './protocol.js';
import { ClaudeProcessor } from './processor.js';
import { UserTokenProvider } from './auth.js';

// ---------------------------------------------------------------------------
// Executor — polls for pending tickets matching its capabilities, runs
// Claude, writes the result, and marks as done.
//
// Never sends Feishu IM messages — that's the Channel's responsibility.
//
// Authentication: prefers OAuth PKCE (UserTokenProvider) if stored tokens
// exist. Falls back to appSecret for legacy setups.
// ---------------------------------------------------------------------------

export class Executor {
  private bitable: BitableClient;
  private session: Session;
  private processor: ClaudeProcessor;
  private running = true;

  constructor(private cfg: Config) {
    const tokenProvider = UserTokenProvider.fromStore(cfg.appId) ?? undefined;
    this.bitable = new BitableClient(cfg, tokenProvider);
    this.session = new Session(cfg.identity, cfg.nickname, cfg, this.bitable);
    this.processor = new ClaudeProcessor(cfg);
  }

  async run(): Promise<void> {
    process.on('SIGTERM', () => this.stop());
    process.on('SIGINT', () => this.stop());

    await this.session.register();
    const caps = this.cfg.executor?.capabilities ?? [];
    console.log(`[executor] started identity=${this.cfg.identity} nickname=${this.cfg.nickname}`);
    if (caps.length > 0) {
      console.log(`[executor] capabilities: ${caps.join(', ')}`);
    }

    await this.coordinationLoop();
    console.log('[executor] stopped');
    process.exit(0);
  }

  stop(): void {
    this.running = false;
    this.processor.abort();
    // Force exit after 5s if still alive (Claude child process tree)
    setTimeout(() => process.exit(0), 5000);
  }

  // -----------------------------------------------------------------------
  // Coordination loop
  // -----------------------------------------------------------------------

  private async coordinationLoop(): Promise<void> {
    const active: Promise<void>[] = [];
    const inFlight = new Set<string>();
    let lastHeartbeat = 0;

    while (this.running) {
      try {
        const now = Date.now();
        if (now - lastHeartbeat > 60_000) {
          await this.session.heartbeat();
          lastHeartbeat = now;
        }

        if (active.length >= this.cfg.maxConcurrency) {
          await sleep(5000);
          continue;
        }

        const tickets = await this.session.searchPending();

        const claimable = tickets.filter((t) => this.isCapabilityMatch(t) && this.session.isClaimable(t) && !this.isOwnRetry(t));
        if (claimable.length > 0) {
          console.log(`[executor] scan: ${claimable.length} claimable tickets`);
        }
        shuffleArray(claimable);

        let claimedAny = false;

        for (const ticket of claimable) {
          if (active.length >= this.cfg.maxConcurrency) break;
          if (!this.running) break;

          const recordId = ticket.record_id;
          if (!recordId) continue;
          // Prevent re-claiming due to Bitable eventual consistency
          if (inFlight.has(recordId)) continue;

          const won = await this.session.claim(ticket);
          if (!won) continue;

          inFlight.add(recordId);
          const promise = this.processTicket(ticket, recordId).finally(() => {
            const idx = active.indexOf(promise);
            if (idx >= 0) active.splice(idx, 1);
            inFlight.delete(recordId);
          });
          active.push(promise);
          claimedAny = true;
        }

        if (!claimedAny) {
          await sleep(this.cfg.peakInterval);
        }
      } catch (err) {
        console.error('[executor] coordination loop error:', err);
        await sleep(30_000);
      }
    }

    await Promise.all(active);
  }

  // -----------------------------------------------------------------------
  // Capability matching
  // -----------------------------------------------------------------------

  /** Returns true if this executor previously failed this ticket (owner starts
   *  with RETRY: and ends with our identity). We skip these to let other
   *  executors retry instead of failing again on the same node. */
  private isOwnRetry(ticket: BitableRecord): boolean {
    const owner = String(ticket.fields[this.cfg.fields.ticket.owner] ?? '');
    return owner.startsWith(RETRY_OWNER_PREFIX) && owner.endsWith(`#${this.cfg.identity}`);
  }

  /** Returns true if this executor has all capabilities the ticket requires. */
  private isCapabilityMatch(ticket: BitableRecord): boolean {
    const capField = String(ticket.fields[this.cfg.fields.ticket.requiredCapabilities] ?? '');
    if (!capField) return true; // no requirements = anyone can take it

    let required: string[];
    try {
      required = JSON.parse(capField);
    } catch {
      required = capField.split(',').map((s) => s.trim()).filter(Boolean);
    }

    if (required.length === 0) return true;

    const myCaps = this.cfg.executor?.capabilities ?? [];
    return required.every((c) => myCaps.includes(c));
  }

  // -----------------------------------------------------------------------
  // Ticket processing
  // -----------------------------------------------------------------------

  private async processTicket(ticket: BitableRecord, recordId: string): Promise<void> {
    const claimId = `${recordId}_${Date.now()}`;
    const rootMsgId = extractText(ticket.fields[this.cfg.fields.ticket.rootMsgId]);
    this.session.logToFile(`ticket=${recordId} started claim_id=${claimId}`);

    try {
      // 1. Fetch turns
      const turns = await this.session.getTurns(recordId);

      // 2. Check if approval is needed (has approvers configured in Roster)
      let needsApproval = !this.cfg.executor?.skipApproval;
      let approvalAtMentions = '';

      if (needsApproval) {
        await this.session.setPendingApproval(recordId);
        // Read back the ticket to check if approvers were actually written
        const updated = await this.session.getTicket(recordId);
        const approvers = updated?.fields[this.cfg.fields.ticket.approvers];
        const openIds = extractUserIds(approvers);
        if (!openIds) {
          // No approvers configured — skip approval, restore status
          this.session.logToFile(`ticket=${recordId} no_approvers`);
          await this.session.setTicketStatus(recordId, this.cfg.statuses.assigned);
          needsApproval = false;
        } else {
          // Build @mention string for the approval message
          const ids = openIds.split(',').map((s: string) => s.trim()).filter(Boolean);
          approvalAtMentions = ids.map((id: string) => `<at id=${id}></at>`).join(' ');
        }
      }

      if (needsApproval) {
        this.session.logToFile(`ticket=${recordId} waiting_approval`);
        await this.session.appendTurn(recordId, 'agent',
          `⏳ 需等待负责人 ${approvalAtMentions} 审批`,
          `${recordId}_approval_wait`, undefined, 'processing', rootMsgId);

        const timeoutMs = (this.cfg.executor?.approvalTimeoutMinutes ?? 30) * 60 * 1000;
        const approval = await this.session.pollApproval(recordId, timeoutMs);

        if (approval !== 'approved') {
          const reason = approval === 'timeout' ? '审批超时' : '审批被驳回';
          console.log(`[executor] ${reason}, releasing ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} ${approval === 'timeout' ? 'approval_timeout' : 'approval_rejected'}`);
          await this.session.release(recordId, this.cfg.statuses.pending);
          await this.session.appendTurn(recordId, 'agent',
            `⏳ 工单未获批准（${reason}），已转人工处理`,
            `${recordId}_rejected`, undefined, 'error', rootMsgId);
          return;
        }

        console.log(`[executor] approval granted ticket=${recordId.slice(0, 12)}`);
        this.session.logToFile(`ticket=${recordId} approval_granted`);

        // Refresh turns after approval (new user messages may have arrived)
        const freshTurns = await this.session.getTurns(recordId);
        Object.assign(turns, freshTurns);
      } else {
        // No approval needed — write ACK
        try {
          const unanswered = this.session.findUnansweredTurns(turns);
          const ackText = this.session.buildAckText(unanswered);
          await this.session.appendTurn(recordId, 'agent', ackText, `${recordId}_ack`, undefined, 'processing', rootMsgId);
          this.session.logToFile(`ticket=${recordId} wrote_ack`);
        } catch (err) {
          console.error(`[executor] write ack failed ${recordId.slice(0, 12)}:`, err);
        }
      }

      // 3. Run Claude
      const ctx = { ticket, turns, config: this.cfg };
      const result = await this.processor.process(ctx);

      if (!result) {
        this.session.logToFile(`ticket=${recordId} error:no_result`);
        await this.session.releaseWithRetry(recordId, 'parse', '输出格式异常无法解析', rootMsgId);
        return;
      }

      // 4. Write answer turn (with optional post-answer review)
      const answer = result.answer || '(无回答)';
      const needsReview = this.cfg.executor?.postReview;
      const turnStatus = needsReview ? 'pending_review' : 'answered';
      try {
        await this.session.appendTurn(recordId, 'agent', answer, claimId, undefined, turnStatus, rootMsgId);
        this.session.logToFile(`ticket=${recordId} wrote_answer${needsReview ? '_pending_review' : ''}`);
      } catch (err) {
        console.error(`[executor] write answer failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:write_answer`);
      }

      // 4b. Post-answer review: wait for review result
      if (needsReview) {
        this.session.logToFile(`ticket=${recordId} waiting_review`);
        await this.session.appendTurn(recordId, 'agent',
          '📋 回答待审核，已通知审核人',
          `${recordId}_review_wait`, undefined, 'processing', rootMsgId);

        const timeoutMs = (this.cfg.executor?.approvalTimeoutMinutes ?? 30) * 60 * 1000;
        const review = await this.session.pollReview(recordId, timeoutMs);

        if (review === 'approved') {
          console.log(`[executor] review approved ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} review_approved`);
        } else if (review === 'rejected') {
          console.log(`[executor] review rejected, re-running Claude ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} review_rejected`);
          // Re-run Claude. The retry answer also goes through review if postReview is set.
          const retryCtx = { ticket, turns: await this.session.getTurns(recordId), config: this.cfg };
          const retryResult = await this.processor.process(retryCtx);
          if (!retryResult) {
            await this.session.releaseWithRetry(recordId, 'review_retry', '审核后重试仍异常', rootMsgId);
            console.log(`[executor] completed ${recordId.slice(0, 12)}`);
            return;
          }
          const retryAnswer = retryResult.answer || '(无回答)';
          const retryTurnStatus = needsReview ? 'pending_review' : 'answered';
          try {
            await this.session.appendTurn(recordId, 'agent', retryAnswer, `${claimId}_retry`, undefined, retryTurnStatus, rootMsgId);
            this.session.logToFile(`ticket=${recordId} wrote_retry_answer${needsReview ? '_pending_review' : ''}`);
          } catch (err) {
            console.error(`[executor] write retry answer failed ${recordId.slice(0, 12)}:`, err);
          }
          // Second review round
          if (needsReview) {
            await this.session.appendTurn(recordId, 'agent',
              '📋 回答已重新生成，再次待审核',
              `${recordId}_review_retry_wait`, undefined, 'processing', rootMsgId);
            const retryReview = await this.session.pollReview(recordId, timeoutMs);
            if (retryReview !== 'approved') {
              await this.session.release(recordId, this.cfg.statuses.pending);
              await this.session.appendTurn(recordId, 'agent',
                retryReview === 'timeout' ? '⏳ 审核超时，已转人工处理' : '⏳ 审核再次打回，已转人工处理',
                `${recordId}_review_rejected_final`, undefined, 'error', rootMsgId);
              console.log(`[executor] completed ${recordId.slice(0, 12)}`);
              return;
            }
          }
          // Approved on retry — write result
          try {
            await this.session.writeResult(recordId, retryAnswer, retryResult.newSummary);
            this.session.logToFile(`ticket=${recordId} result written (retry)`);
          } catch (err) {
            console.error(`[executor] writeResult (retry) failed ${recordId.slice(0, 12)}:`, err);
          }
          console.log(`[executor] completed ${recordId.slice(0, 12)}`);
          return;
        } else {
          // timeout
          console.log(`[executor] review timeout, releasing ticket=${recordId.slice(0, 12)}`);
          this.session.logToFile(`ticket=${recordId} review_timeout`);
          await this.session.release(recordId, this.cfg.statuses.pending);
          await this.session.appendTurn(recordId, 'agent',
            '⏳ 审核超时，已转人工处理',
            `${recordId}_review_timeout`, undefined, 'error', rootMsgId);
          console.log(`[executor] completed ${recordId.slice(0, 12)}`);
          return;
        }
      }

      // 5. Write result and mark done (Channel will notify the user)
      try {
        await this.session.writeResult(recordId, answer, result.newSummary);
        this.session.logToFile(`ticket=${recordId} result written`);
      } catch (err) {
        console.error(`[executor] writeResult failed ${recordId.slice(0, 12)}:`, err);
        this.session.logToFile(`ticket=${recordId} error:writeResult`);
      }

      console.log(`[executor] completed ${recordId.slice(0, 12)}`);
    } catch (err) {
      console.error(`[executor] unhandled error ${recordId.slice(0, 12)}:`, err);
      this.session.logToFile(`ticket=${recordId} error:unhandled`);
      await this.session.releaseWithRetry(recordId, 'unhandled', '未知错误', rootMsgId);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function shuffleArray<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}
