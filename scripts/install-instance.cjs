#!/usr/bin/env node
// Installs the portable workflows/ and schemas/ into an empty n8n instance through its public API.
// Usage: node scripts/install-instance.cjs --base https://host --key-file .env.api
//          --chat 123456789 [--chat ...] --admin 123456789 --label Monitor [--tick 5] [--interval 60]
// The instance needs an owner, an API key (N8N_API_KEY=... in the key file) and exactly one
// Telegram credential created in the UI. Workflows are imported inactive except commands and watchdog.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = { chat: [] };
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i].replace(/^--/, ''), v = process.argv[i + 1];
  if (k === 'chat') args.chat.push(v); else args[k] = v;
}
const base = String(args.base || '').replace(/\/+$/, '');
const tick = Number(args.tick || 1), interval = Number(args.interval || 20);
if (!base || !args['key-file'] || !args.chat.length || !args.chat.every(c => /^\d+$/.test(c))
  || !/^\d+$/.test(args.admin || '') || !args.label
  || !Number.isInteger(tick) || tick < 1 || !Number.isInteger(interval) || interval < 10 || interval > 360) {
  console.error('Usage: --base URL --key-file FILE --chat ID [--chat ID] --admin ID --label NAME [--tick 1..] [--interval 10..360]');
  process.exit(2);
}
const key = (fs.readFileSync(path.resolve(args['key-file']), 'utf8').match(/^N8N_API_KEY=(.+)$/m) || [])[1]?.trim();
if (!key) throw new Error('N8N_API_KEY not found in key file');

// Placeholder table and workflow IDs embedded in the portable JSON.
const SOURCE_TABLES = {
  searches: 'TABLE_SEARCHES', seen_items: 'TABLE_SEEN_ITEMS', notifications: 'TABLE_NOTIFICATIONS',
  command_receipts: 'TABLE_COMMAND_RECEIPTS', monitor_state: 'TABLE_MONITOR_STATE', metric_samples: 'TABLE_METRIC_SAMPLES',
};
const SOURCE_PRODUCER = 'WORKFLOW_MONITOR', SOURCE_SENDER = 'WORKFLOW_SENDER';
const TICK_NODES = ['Check timer', 'Sender timer'];

async function api(method, p, body) {
  const r = await fetch(base + '/api/v1' + p, {
    method, headers: { 'X-N8N-API-KEY': key, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const list = async p => (await api('GET', p)).data;

function prepare(file, ids) {
  let text = fs.readFileSync(path.join(root, 'workflows', file), 'utf8');
  for (const [from, to] of Object.entries(ids)) text = text.split(from).join(to);
  return JSON.parse(text);
}

function attachCredentials(wf, creds) {
  for (const n of wf.nodes) {
    const p = n.parameters || {};
    if (/^n8n-nodes-base\.telegram(Trigger)?$/.test(n.type)) n.credentials = { telegramApi: creds.telegram };
    if (n.type === 'n8n-nodes-base.n8n' || p.nodeCredentialType === 'n8nApi') n.credentials = { n8nApi: creds.n8nApi };
  }
}

async function createWorkflow(wf) {
  const { saveExecutionProgress, saveDataErrorExecution, saveDataSuccessExecution, timezone, executionOrder, callerPolicy } = wf.settings || {};
  const settings = { saveExecutionProgress, saveDataErrorExecution, saveDataSuccessExecution, timezone, executionOrder, callerPolicy };
  return api('POST', '/workflows', { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings, nodeGroups: wf.nodeGroups || [] });
}

(async () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'data-tables.json'), 'utf8'));
  const sources = ['marketplace-monitor.json', 'telegram-notifications.json', 'telegram-commands.json', 'watchdog.json'];
  const names = sources.map(f => JSON.parse(fs.readFileSync(path.join(root, 'workflows', f), 'utf8')).name);

  // Refuse to touch an instance that already has any of these objects.
  const tables = await list('/data-tables?limit=250');
  const workflows = await list('/workflows?limit=250');
  const clash = [...tables.filter(t => t.name in SOURCE_TABLES).map(t => t.name), ...workflows.filter(w => names.includes(w.name)).map(w => w.name)];
  if (clash.length) throw new Error('Already present, aborting: ' + clash.join(', '));

  const creds = await list('/credentials?limit=250');
  const telegram = creds.filter(c => c.type === 'telegramApi');
  if (telegram.length !== 1) throw new Error(`Expected exactly one Telegram credential, found ${telegram.length}`);
  let n8nApi = creds.find(c => c.type === 'n8nApi' && c.name === 'Marketplace service control');
  if (!n8nApi) n8nApi = await api('POST', '/credentials', {
    name: 'Marketplace service control', type: 'n8nApi', data: { apiKey: key, baseUrl: 'http://127.0.0.1:5678/api/v1' },
  });
  const credRefs = { telegram: { id: telegram[0].id, name: telegram[0].name }, n8nApi: { id: n8nApi.id, name: n8nApi.name } };

  const ids = {};
  for (const t of schema.tables) {
    const created = await api('POST', '/data-tables', { name: t.name, columns: t.columns });
    ids[SOURCE_TABLES[t.name]] = created.id;
    console.log(`table ${t.name}: ${created.id}`);
  }
  const stateId = ids[SOURCE_TABLES.monitor_state];
  const now = new Date().toISOString();
  const role = name => ({ name, owner: 'free', owner_workflow: '', started_at: now, finished_at: now });
  await api('POST', `/data-tables/${stateId}/rows`, { returnType: 'count', data: [
    { ...role('monitor'), resume_after_id: '', next_start_at: now, last_started_at: now, last_completed_at: now },
    role('sender'), role('commands'),
    { name: 'service', enabled: true, interval_seconds: interval, last_send_at: now },
  ] });

  const [producer, sender, commands, watchdog] = sources.map(f => prepare(f, ids));
  for (const wf of [producer, sender]) for (const n of wf.nodes) {
    if (TICK_NODES.includes(n.name)) n.parameters.rule.interval[0].secondsInterval = tick;
  }
  const settingsNode = producer.nodes.find(n => n.name === 'Telegram settings');
  settingsNode.parameters.jsonOutput = JSON.stringify({ chat_ids: args.chat }, null, 2);
  for (const wf of [producer, sender, commands, watchdog]) attachCredentials(wf, credRefs);

  const p = await createWorkflow(producer), s = await createWorkflow(sender);
  const accept = commands.nodes.find(n => n.name === 'Receive message');
  const allowedBefore = accept.parameters.jsCode;
  accept.parameters.jsCode = allowedBefore.replace('allowedChats = ["0"]', 'allowedChats = ' + JSON.stringify(args.chat));
  if (accept.parameters.jsCode === allowedBefore) throw new Error('allowedChats placeholder not found');
  for (const n of commands.nodes) if (n.type === 'n8n-nodes-base.code') {
    n.parameters.jsCode = n.parameters.jsCode.split(SOURCE_PRODUCER).join(p.id).split(SOURCE_SENDER).join(s.id);
  }
  const c = await createWorkflow(commands);
  await api('POST', `/workflows/${c.id}/activate`);
  const watchdogSettings = watchdog.nodes.find(n => n.name === 'Watchdog settings');
  watchdogSettings.parameters.jsonOutput = JSON.stringify({ admin_chat_id: args.admin, label: args.label, monitor_id: p.id, sender_id: s.id }, null, 2);
  const wd = await createWorkflow(watchdog);
  await api('POST', `/workflows/${wd.id}/activate`);
  console.log(`workflows: producer ${p.id}, sender ${s.id}, commands ${c.id}, watchdog ${wd.id} (commands and watchdog active)`);
})().catch(e => { console.error(e.message); process.exit(1); });
