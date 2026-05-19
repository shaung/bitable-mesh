// Add missing 0.0.2 fields to existing Bitable tables
// Usage: npx tsx scripts/update-0.0.2-fields.ts
import { readFileSync } from 'node:fs';
import { Client } from '@larksuiteoapi/node-sdk';

function loadEnv() {
  try {
    const content = readFileSync('.env', 'utf-8');
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
  } catch {}
}
loadEnv();

const appId = process.env.BITABLE_APP_ID!;
const appSecret = process.env.BITABLE_APP_SECRET!;
const appToken = 'QBXrbAgO5aYG06szQW0caghvnGh';

const client = new Client({ appId, appSecret, domain: 'https://open.feishu.cn' });

const FT = { Text: 1, Number: 2, SingleSelect: 3, MultiSelect: 4, Checkbox: 7, Person: 11 };

async function listFields(tableId: string): Promise<string[]> {
  const resp = (await client.bitable.appTableField.list({
    path: { app_token: appToken, table_id: tableId },
    params: { page_size: 100 },
  })) as any;
  return (resp?.data?.items ?? []).map((f: any) => f.field_name);
}

async function addField(tableId: string, field: Record<string, unknown>) {
  const resp = (await client.bitable.appTableField.create({
    path: { app_token: appToken, table_id: tableId },
    data: field,
  })) as any;
  if (resp.code !== 0) {
    console.log(`  ⚠ ${field.field_name}: ${resp.msg ?? JSON.stringify(resp)}`);
  } else {
    console.log(`  ✓ ${field.field_name} added`);
  }
}

async function main() {
  // Ticket: tblIOqcYauAE2AwT
  console.log('\n╶ Ticket table ╶');
  const tFields = await listFields('tblIOqcYauAE2AwT');
  if (!tFields.includes('for_kind')) {
    await addField('tblIOqcYauAE2AwT', {
      field_name: 'for_kind', type: FT.SingleSelect,
      property: { options: [{ name: 'human', color: 0 }, { name: 'agent', color: 1 }] },
    });
  } else console.log('  - for_kind exists');
  if (!tFields.includes('metadata')) {
    await addField('tblIOqcYauAE2AwT', { field_name: 'metadata', type: FT.Text });
  } else console.log('  - metadata exists');

  // Turn: tbl0THicfsSR22LX
  console.log('\n╶ Turn table ╶');
  const trFields = await listFields('tbl0THicfsSR22LX');
  if (!trFields.includes('metadata')) {
    await addField('tbl0THicfsSR22LX', { field_name: 'metadata', type: FT.Text });
  } else console.log('  - metadata exists');

  // Roster: tblYbhOfZgTFIflf
  console.log('\n╶ Roster table ╶');
  const rFields = await listFields('tblYbhOfZgTFIflf');
  if (!rFields.includes('kind')) {
    await addField('tblYbhOfZgTFIflf', {
      field_name: 'kind', type: FT.SingleSelect,
      property: { options: [{ name: 'human', color: 0 }, { name: 'agent', color: 1 }, { name: 'system', color: 2 }] },
    });
  } else console.log('  - kind exists');
  if (!rFields.includes('enabled')) {
    await addField('tblYbhOfZgTFIflf', { field_name: 'enabled', type: FT.Checkbox });
  } else console.log('  - enabled exists');

  console.log('\n✓ Done. Note: field renames (required_capabilities→for_roles etc.) skipped — TOML mapping handles this.');
}

main().catch(console.error);
