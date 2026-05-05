#!/usr/bin/env node
import { loadConfig, validateConfig, profilePath, readProfile, saveProfile } from './config.js';
import { setLogLevel } from './log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse CLI args. Returns profile name and positional args. Also counts -v flags. */
function parseArgs(): { profile: string; positional: string[]; verbosity: number } {
  const positional: string[] = [];
  let profile = 'default';
  let verbosity = 0;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p' || args[i] === '--profile') {
      if (args[i + 1]) profile = args[++i];
    } else if (args[i] === '-v') {
      verbosity++;
    } else if (args[i] === '-vv') {
      verbosity += 2;
    } else if (args[i].startsWith('-v') && args[i].length > 2) {
      verbosity += args[i].length - 1; // -vvv → 3
    } else {
      positional.push(args[i]);
    }
  }
  return { profile, positional, verbosity };
}

/**
 * Auto-login for join mode (OAuth PKCE, no appSecret).
 * Returns true if login was performed.
 */
async function ensureLogin(cfg: ReturnType<typeof loadConfig>, profile: string): Promise<boolean> {
  const { UserTokenProvider, loadStoredTokens } = await import('./auth.js');
  if (UserTokenProvider.fromStore(cfg.appId)) return false;

  if (!cfg.appId) {
    console.error('Config must include appId. Run `bitable-mesh setup` first.');
    process.exit(1);
  }

  console.log('No access token found. Starting automatic login...\n');
  await UserTokenProvider.login(cfg.appId, cfg.openApiDomain);

  // Save ownerOpenId to profile if available
  const stored = loadStoredTokens(cfg.appId);
  if (stored?.userId) {
    const raw = readProfile(profile) || {};
    raw.ownerOpenId = stored.userId;
    saveProfile(profile, raw);
    console.log(`✓ ownerOpenId saved to profile "${profile}"`);
  }
  console.log('✓ Login complete.\n');
  return true;
}

/** Check if profile exists; prompt to run setup if not. */
async function ensureSetup(profile: string): Promise<string> {
  const path = profilePath(profile);
  const { existsSync } = await import('node:fs');
  if (existsSync(path)) return profile;

  const { stdin, stdout } = await import('node:process');
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`Profile "${profile}" not found. Run interactive setup? [Y/n]: `, (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });

  if (answer === 'n') {
    console.error(`Cannot proceed without profile. Run \`bitable-mesh setup -p ${profile}\` to create it.`);
    process.exit(1);
  }

  const { interactiveSetup } = await import('./setup.js');
  await interactiveSetup(profile);
  return profile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const { profile, positional, verbosity } = parseArgs();
  setLogLevel(verbosity);
  const cmd = positional[0];

  // `bitable-mesh login` — interactive OAuth PKCE flow
  if (cmd === 'login') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    if (!cfg.appId) {
      console.error('Config must include appId. Run `bitable-mesh setup` first.');
      process.exit(1);
    }
    console.log('Starting Feishu OAuth authorization (PKCE mode)...\n');
    const { UserTokenProvider, loadStoredTokens } = await import('./auth.js');
    await UserTokenProvider.login(cfg.appId, cfg.openApiDomain);

    const stored = loadStoredTokens(cfg.appId);
    if (stored?.userId) {
      const raw = readProfile(profile) || {};
      raw.ownerOpenId = stored.userId;
      saveProfile(profile, raw);
      console.log(`✓ ownerOpenId saved to profile "${profile}"`);
    }

    const host = cfg.openApiDomain ?? 'open.feishu.cn';
    const name = stored?.userName ?? stored?.userId ?? '';
    console.log(`✓ Authorization successful (${host}) ${name ? `— logged in as ${name}` : ''}`);
    return;
  }

  // `bitable-mesh setup` — interactive guided setup wizard
  if (cmd === 'setup') {
    const { interactiveSetup } = await import('./setup.js');
    await interactiveSetup(profile);
    return;
  }

  // `bitable-mesh channel` — IM communication daemon
  if (cmd === 'channel') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const { Channel } = await import('./channel.js');
    const channel = new Channel(cfg);
    await channel.run();
    return;
  }

  // `bitable-mesh operator` — DEPRECATED
  if (cmd === 'operator') {
    console.warn('[deprecated] `operator` command is deprecated. Use `channel` instead.');
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const { Channel } = await import('./channel.js');
    const channel = new Channel(cfg);
    await channel.run();
    return;
  }

  // `bitable-mesh join` — process tickets and write results
  if (cmd === 'join') {
    await ensureSetup(profile);
    let cfg = loadConfig(profile);

    // --skip-approval flag
    if (process.argv.includes('--skip-approval')) {
      cfg.executor = cfg.executor || { capabilities: [] };
      cfg.executor.skipApproval = true;
    }

    // Join always uses OAuth PKCE. Auto-login if needed.
    const loggedIn = await ensureLogin(cfg, profile);
    if (loggedIn) cfg = loadConfig(profile);

    validateConfig(cfg);

    const { Executor } = await import('./executor.js');
    const executor = new Executor(cfg);
    await executor.run();
    return;
  }

  // `bitable-mesh direct` — stateless WS→Claude→reply mode
  if (cmd === 'direct') {
    await ensureSetup(profile);
    const cfg = loadConfig(profile);
    validateConfig(cfg);

    const { DirectMode } = await import('./direct.js');
    const direct = new DirectMode(cfg);
    await direct.run();
    return;
  }

  // Default — print help
  if (cmd) {
    console.error(`Unknown command: ${cmd}`);
  }
  console.log('Usage: bitable-mesh [--profile <name>] <command>');
  console.log('  -p, --profile <name>  Use profile (default: "default")');
  console.log('');
  console.log('Commands:');
  console.log('  join       — process tickets (auto-login)');
  console.log('  channel    — listen for IM messages');
  console.log('  direct     — stateless WS→Claude→reply');
  console.log('  login      — OAuth PKCE authorization');
  console.log('  setup      — interactive configuration wizard');
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('/cli.ts') || process.argv[1].endsWith('/cli.js')
  || process.argv[1].endsWith('/bitable-mesh.js')
);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
