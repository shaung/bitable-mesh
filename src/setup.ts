import { Client } from '@larksuiteoapi/node-sdk';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { getDomainConfig } from './domain.js';

// ---------------------------------------------------------------------------
// Bitable field type constants
// ---------------------------------------------------------------------------

const FT = {
  Text: 1,
  Number: 2,
  SingleSelect: 3,
  Checkbox: 4,
  Person: 11,
  CreatedTime: 1001,
  ModifiedTime: 1002,
} as const;

interface FieldDef {
  field_name: string;
  type: number;
  property?: Record<string, unknown>;
}

export interface SetupResult {
  appToken: string;
  appUrl?: string;
  ticketsTableId: string;
  turnsTableId: string;
  rosterTableId: string;
  capabilitiesWhitelistTableId?: string;
}

export interface SetupOptions {
  appId: string;
  appSecret: string;
  openApiDomain?: string;
  appName?: string;
  /** Feishu open_id to grant edit permission and register as Roster.human. */
  ownerOpenId?: string;
}

// ---------------------------------------------------------------------------
// Interactive prompt helpers (zero dependencies)
// ---------------------------------------------------------------------------

function ask(query: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  return new Promise((resolve) => {
    rl.question(query, (answer) => { rl.close(); resolve(answer); });
  });
}

async function select(label: string, options: string[]): Promise<number> {
  console.log(`\n${label}`);
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i]}`);
  }
  const raw = await ask('\nChoice: ');
  const idx = parseInt(raw, 10);
  if (idx >= 1 && idx <= options.length) return idx - 1;
  console.log('  Invalid choice, defaulting to first option.');
  return 0;
}

// ---------------------------------------------------------------------------
// Parse a Feishu/Lark Bitable URL to extract app_token and detect domain
// ---------------------------------------------------------------------------

interface ParsedBitableUrl {
  appToken: string;
  openApiDomain?: string;
}

function parseBitableUrl(url: string): ParsedBitableUrl | null {
  try {
    const parsed = new URL(url.trim());
    const match = parsed.pathname.match(/\/base\/([a-zA-Z0-9]+)/);
    if (!match) return null;

    let openApiDomain: string | undefined;
    const host = parsed.hostname;
    if (host.includes('larksuite.com')) openApiDomain = 'open.larksuite.com';
    else if (host.includes('feishu.cn') || host.endsWith('.feishu.cn')) openApiDomain = 'open.feishu.cn';
    // For unrecognized hosts, leave undefined (user will confirm domain)

    return { appToken: match[1], openApiDomain };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load .env into process.env (mirrors config.ts logic)
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
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch { /* .env is optional at this point */ }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Load .env from project root
for (const dir of [ROOT, process.cwd()]) {
  const p = join(dir, '.env');
  if (existsSync(p)) { loadEnvFile(p); break; }
}

// ---------------------------------------------------------------------------
// Create a Lark SDK Client from credentials
// ---------------------------------------------------------------------------

function createClient(opts: { appId: string; appSecret: string; openApiDomain?: string }): Client {
  const dc = getDomainConfig(opts.openApiDomain);
  return new Client({ appId: opts.appId, appSecret: opts.appSecret, domain: dc.sdkBaseUrl });
}

// ---------------------------------------------------------------------------
// List all tables in a Bitable base
// ---------------------------------------------------------------------------

interface TableInfo {
  table_id: string;
  name?: string;
}

async function listTables(client: Client, appToken: string): Promise<TableInfo[]> {
  const tables: TableInfo[] = [];
  let pageToken: string | null = null;

  for (let i = 0; i < 20; i++) {
    const resp = await client.bitable.appTable.list({
      path: { app_token: appToken },
      params: { page_token: pageToken ?? undefined, page_size: 50 } as any,
    });
    if (resp.code !== 0) {
      throw new Error(`List tables failed: ${JSON.stringify(resp)}`);
    }
    const items = (resp.data?.items ?? []) as any[];
    for (const item of items) {
      tables.push({ table_id: item.table_id, name: item.name });
    }
    if (!resp.data?.has_more) break;
    pageToken = (resp.data?.page_token as string) ?? null;
  }
  return tables;
}

// ---------------------------------------------------------------------------
// Create a single table with fields
// ---------------------------------------------------------------------------

async function createTable(
  client: Client,
  appToken: string,
  name: string,
  fields: FieldDef[],
): Promise<string> {
  const resp = await client.bitable.appTable.create({
    path: { app_token: appToken },
    data: { table: { name, fields: fields as any } },
  });
  if (resp.code !== 0) {
    throw new Error(`Create table "${name}" failed: ${JSON.stringify(resp)}`);
  }
  const tableId = (resp.data as any)?.table_id;
  if (!tableId) {
    throw new Error(`No table_id in response for "${name}": ${JSON.stringify(resp)}`);
  }
  return tableId;
}

// ---------------------------------------------------------------------------
// Programmatic Bitable creation (headless / imported use)
// ---------------------------------------------------------------------------

export async function createBitableMesh(opts: SetupOptions): Promise<SetupResult> {
  const client = createClient(opts);

  const appName = opts.appName ?? 'bitable-mesh';
  console.log(`  Creating bitable "${appName}"...`);
  const appResp = await client.bitable.app.create({
    data: { name: appName },
  });
  if (appResp.code !== 0 || !appResp.data?.app?.app_token) {
    throw new Error(`Create bitable app failed: ${JSON.stringify(appResp)}`);
  }
  const appToken = appResp.data.app.app_token;
  const appUrl = appResp.data.app.url;
  console.log(`  ✓ app_token: ${appToken}`);
  if (appUrl) console.log(`  ✓ url: ${appUrl}`);

  console.log('  Creating tables...');
  const ticketsTableId = await createTable(client, appToken, 'Tickets', [
    { field_name: 'root_msg_id', type: FT.Text },
    { field_name: 'status', type: FT.SingleSelect, property: { options: [
      { name: 'draft', color: 0 },
      { name: 'pending', color: 1 },
      { name: 'assigned', color: 2 },
      { name: 'pending_approval', color: 6 },
      { name: 'done', color: 3 },
      { name: 'failed', color: 4 },
      { name: 'closed', color: 5 },
    ]}},
    { field_name: 'owner', type: FT.Text },
    { field_name: 'owner_lease_at', type: FT.Number },
    { field_name: 'retry_count', type: FT.Number },
    { field_name: 'summary', type: FT.Text },
    { field_name: 'keyfacts', type: FT.Text },
    { field_name: 'chat_id', type: FT.Text },
    { field_name: 'sender_id', type: FT.Text },
    { field_name: 'required_capabilities', type: FT.Text },
    { field_name: 'result', type: FT.Text },
    { field_name: 'conversation_id', type: FT.Text },
    { field_name: 'approvers', type: FT.Person, property: { multiple: true } },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Tickets: ${ticketsTableId}`);

  const turnsTableId = await createTable(client, appToken, 'Turns', [
    { field_name: 'root_msg_id', type: FT.Text },
    { field_name: 'ticket_record_id', type: FT.Text },
    { field_name: 'role', type: FT.Text },
    { field_name: 'content', type: FT.Text },
    { field_name: 'turn_status', type: FT.SingleSelect, property: { options: [
      { name: 'processing', color: 0 },
      { name: 'answered', color: 1 },
      { name: 'error', color: 2 },
      { name: 'pending_review', color: 6 },
      { name: 'approved', color: 3 },
      { name: 'rejected', color: 4 },
    ]}},
    { field_name: 'dedup_key', type: FT.Text },
    { field_name: 'agent_identity', type: FT.Text },
    { field_name: 'human', type: FT.Person, property: { multiple: true } },
    { field_name: 'delivery_owner', type: FT.Text },
    { field_name: 'delivery_lease_at', type: FT.Number },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'notified', type: FT.Number },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Turns: ${turnsTableId}`);

  const rosterTableId = await createTable(client, appToken, 'Roster', [
    { field_name: 'identity', type: FT.Text },
    { field_name: 'nickname', type: FT.Text },
    { field_name: 'role', type: FT.Text },
    { field_name: 'channel_type', type: FT.Text },
    { field_name: 'hostname', type: FT.Text },
    { field_name: 'user', type: FT.Text },
    { field_name: 'pid', type: FT.Text },
    { field_name: 'last_seen_at', type: FT.Number },
    { field_name: 'registered_at', type: FT.Number },
    { field_name: 'capabilities', type: FT.Text },
    { field_name: 'human', type: FT.Person, property: { multiple: true } },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Roster: ${rosterTableId}`);

  const capabilitiesWhitelistTableId = await createTable(client, appToken, 'Capabilities', [
    { field_name: 'capability', type: FT.Text },
    { field_name: 'display_name', type: FT.Text },
    { field_name: 'description', type: FT.Text },
    { field_name: 'keywords', type: FT.Text },
    { field_name: 'prompt', type: FT.Text },
    { field_name: 'enabled', type: FT.Checkbox },
    { field_name: 'created_at', type: FT.CreatedTime },
    { field_name: 'updated_at', type: FT.ModifiedTime },
  ]);
  console.log(`  ✓ Capabilities: ${capabilitiesWhitelistTableId}`);

  if (opts.ownerOpenId) {
    try {
      await client.bitable.v1.appRole.create({
        path: { app_token: appToken },
        data: {
          role_name: 'editor',
          member_list: [
            { member_type: 'open_id', member_id: opts.ownerOpenId },
          ],
        },
      } as any);
      console.log(`  ✓ Granted edit access to ${opts.ownerOpenId}`);
    } catch (err: any) {
      console.log(`  ⚠ Could not auto-grant access to ${opts.ownerOpenId}: ${err.message ?? JSON.stringify(err)}`);
      console.log(`    Please manually add them as collaborator in the Bitable sharing settings.`);
    }
  }

  return { appToken, appUrl, ticketsTableId, turnsTableId, rosterTableId, capabilitiesWhitelistTableId };
}

// ---------------------------------------------------------------------------
// Build a complete config object from template + discovered IDs
// ---------------------------------------------------------------------------

function buildConfig(
  fields: { appId: string; openApiDomain?: string; ownerOpenId?: string },
  result: SetupResult,
): Record<string, unknown> {
  return {
    appId: fields.appId,
    openApiDomain: fields.openApiDomain || 'open.larksuite.com',
    appToken: result.appToken,
    ticketsTableId: result.ticketsTableId,
    turnsTableId: result.turnsTableId,
    rosterTableId: result.rosterTableId,
    ...(fields.ownerOpenId ? { ownerOpenId: fields.ownerOpenId } : {}),
    ...(result.capabilitiesWhitelistTableId ? { capabilitiesWhitelistTableId: result.capabilitiesWhitelistTableId } : {}),
    channel: { enabled: true, useLLM: false, draftTTLMinutes: 60, pollIntervalSeconds: 3, capabilitiesMapping: 'keyword' },
    executor: { capabilities: [], skipApproval: false, approvalTimeoutMinutes: 30, postReview: false },
    prompt: 'You are a technical support agent. Answer user questions professionally.',
  };
}

// ---------------------------------------------------------------------------
// Interactive setup wizard
// ---------------------------------------------------------------------------

export async function interactiveSetup(profile = 'default'): Promise<void> {
  console.log('');
  console.log('  ╔══════════════════════════════════════════════════════╗');
  console.log('  ║              bitable-mesh Setup Wizard               ║');
  console.log('  ║                                                      ║');
  console.log('  ║  This wizard will help you configure a Feishu        ║');
  console.log('  ║  Bitable base for distributed agent collaboration.   ║');
  console.log('  ╚══════════════════════════════════════════════════════╝');
  console.log('');

  // =========================================================================
  // Step 1: Server domain
  // =========================================================================

  console.log('Step 1: Lark / Feishu Server');
  console.log('  Which server does your account belong to?\n');
  const domainChoices = [
    { label: 'International — Lark (larksuite.com)', domain: 'open.larksuite.com' },
    { label: 'Chinese — 飞书 (feishu.cn)', domain: 'open.feishu.cn' },
    { label: 'Custom — specify manually', domain: '' },
  ];
  for (let i = 0; i < domainChoices.length; i++) {
    console.log(`  ${i + 1}) ${domainChoices[i].label}`);
  }
  const domainRaw = await ask('\nChoice [1]: ');
  const domainIdx = parseInt(domainRaw, 10) || 1;
  let openApiDomain: string;
  if (domainIdx === 2) {
    openApiDomain = 'open.feishu.cn';
  } else if (domainIdx === 3) {
    openApiDomain = await ask('  Enter Open API domain (e.g., open.larksuite.com): ');
    if (!openApiDomain) openApiDomain = 'open.larksuite.com';
  } else {
    openApiDomain = 'open.larksuite.com';
  }
  console.log(`  → Server: ${openApiDomain}`);

  // =========================================================================
  // Step 2: Credentials
  // =========================================================================

  console.log('\nStep 2: Feishu App Credentials');
  console.log('  appId is required. appSecret is only needed for Channel (IM) mode.');
  console.log('  For join (Executor) mode with OAuth PKCE, appSecret can be left empty.\n');
  let appId = '';
  let appSecret = process.env.BITABLE_APP_SECRET || '';

  if (appSecret) {
    console.log(`  Using appSecret from .env: ${maskMiddle(appSecret)}`);
    const reuse = await ask('  Use this appSecret? [Y/n]: ');
    if (reuse.toLowerCase() === 'n') appSecret = '';
  }

  appId = await ask('  appId (required): ');
  if (!appId) {
    console.error('  Error: appId is required.');
    return;
  }

  if (!appSecret) {
    const input = await ask('  appSecret (optional, press Enter to skip): ');
    if (input.trim()) appSecret = input.trim();
  }

  if (appSecret) {
    const saveEnv = await ask('\n  Save appSecret to .env for future use? [Y/n]: ');
    if (saveEnv.toLowerCase() !== 'n') {
      const envPath = join(ROOT, '.env');
      const line = `\nBITABLE_APP_SECRET="${appSecret}"\n`;
      appendFileSync(envPath, line, 'utf-8');
      console.log(`  ✓ Appended to ${envPath}`);
      process.env.BITABLE_APP_SECRET = appSecret;
    }
  }

  // =========================================================================
  // Step 3: Owner
  // =========================================================================

  // Step 3 removed — identity collected via `bitable-mesh login` (OAuth PKCE).
  let ownerOpenId = process.env.OWNER_OPEN_ID || undefined;

  // =========================================================================
  // Step 4: Bitable mode
  // =========================================================================

  console.log('\nStep 4: Bitable Configuration');
  const modeIdx = await select(
    '  How would you like to set up the bitable?',
    ['Create a new Bitable base automatically', 'Use an existing Bitable base'],
  );

  let result: SetupResult;

  if (modeIdx === 0) {
    // -- Create new ---------------------------------------------------------
    console.log('');
    const meshName = await ask('  Name for the new base [bitable-mesh]: ');
    result = await createBitableMesh({
      appId, appSecret, openApiDomain, appName: meshName || 'bitable-mesh',
      ownerOpenId: ownerOpenId,
    });
    console.log('\n  ✓ Bitable is ready!');
  } else {
    // -- Use existing -------------------------------------------------------
    console.log('');
    const url = await ask('  Paste your Bitable URL:\n  > ');
    const parsed = parseBitableUrl(url);
    if (!parsed) {
      console.error('  Error: Could not parse URL. Expected format:');
      console.error('    https://<org>.larksuite.com/base/<app_token>');
      return;
    }

    // Detect or confirm domain from URL
    if (parsed.openApiDomain && parsed.openApiDomain !== openApiDomain) {
      console.log(`\n  Note: URL suggests "${parsed.openApiDomain}" but you selected "${openApiDomain}".`);
      const override = await ask(`  Use "${parsed.openApiDomain}" instead? [Y/n]: `);
      if (override.toLowerCase() !== 'n') openApiDomain = parsed.openApiDomain;
    }
    console.log(`  ✓ app_token: ${parsed.appToken}`);

    // List tables
    console.log('\n  Fetching tables...');
    const client = createClient({ appId, appSecret, openApiDomain });
    let tables: TableInfo[];
    try {
      tables = await listTables(client, parsed.appToken);
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
      console.error('  Make sure the app has access to this base and the URL is correct.');
      return;
    }

    if (tables.length === 0) {
      console.error('  Error: No tables found in this base.');
      return;
    }

    console.log(`  Found ${tables.length} table(s):\n`);
    for (let i = 0; i < tables.length; i++) {
      console.log(`    ${i + 1}) ${tables[i].name ?? '(unnamed)'}  (${tables[i].table_id})`);
    }

    // Map tables to roles
    console.log('\n  Which table should be used for each role?\n');
    const roleMap: Record<string, string> = {};
    const roles = ['Tickets (task tickets)', 'Turns (conversation turns)', 'Roster (agent registry)'];
    const configKeys = ['ticketsTableId', 'turnsTableId', 'rosterTableId'];
    const usedIndices = new Set<number>();

    for (let r = 0; r < roles.length; r++) {
      const available = tables
        .map((t, i) => ({ ...t, i }))
        .filter((t) => !usedIndices.has(t.i));
      if (available.length === 0) {
        console.error('  Error: Not enough tables to assign all roles.');
        return;
      }

      console.log(`  For ${roles[r]}:`);
      for (let j = 0; j < available.length; j++) {
        // Show original index for reference
        const label = available[j].name ?? '(unnamed)';
        console.log(`    ${j + 1}) ${label}`);
      }
      const pick = await ask(`  Choice [1]: `);
      const pickIdx = (parseInt(pick, 10) || 1) - 1;
      const clampedIdx = Math.max(0, Math.min(pickIdx, available.length - 1));
      const chosen = available[clampedIdx];
      roleMap[configKeys[r]] = chosen.table_id;
      usedIndices.add(chosen.i);
      console.log(`  → ${roles[r]} ← ${chosen.name ?? chosen.table_id}\n`);
    }

    result = {
      appToken: parsed.appToken,
      appUrl: url,
      ticketsTableId: roleMap.ticketsTableId,
      turnsTableId: roleMap.turnsTableId,
      rosterTableId: roleMap.rosterTableId,
    };
  }

  // =========================================================================
  // Step 5: Save profile
  // =========================================================================

  console.log('\nStep 5: Save Profile');
  const config = buildConfig({ appId, openApiDomain, ownerOpenId }, result);
  const { saveProfile, profilePath } = await import('./config.js');
  saveProfile(profile, config);
  const savedPath = profilePath(profile);
  console.log(`  ✓ Profile saved to ${savedPath}`);
  console.log('');

  // Summary
  const appUrl = result.appUrl ?? `${openApiDomain === 'open.larksuite.com' ? 'https://bytedance.larksuite.com' : 'https://bytedance.feishu.cn'}/base/${result.appToken}`;
  console.log('  ── Setup complete ──');
  console.log(`  app_token:    ${result.appToken}`);
  console.log(`  tickets:      ${result.ticketsTableId}`);
  console.log(`  turns:        ${result.turnsTableId}`);
  console.log(`  roster:       ${result.rosterTableId}`);
  console.log('');
  console.log(`  To start the daemon:\n    npx tsx src/cli.ts join -p ${profile}`);
  console.log('');
  console.log(`  Open in browser:\n    ${appUrl}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Utility — mask a string for display
// ---------------------------------------------------------------------------

function maskMiddle(s: string): string {
  if (s.length <= 8) return s.slice(0, 4) + '…' + s.slice(-2);
  return s.slice(0, 6) + '…' + s.slice(-4);
}
