// Runs the real bridge and two real shims. An MCP client stands in for each Claude Code session.
// Run: node --test tests/routing.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = join(ROOT, 'claude-integration', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
const { Client } = await import(pathToFileURL(join(SDK, 'client', 'index.js')))
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'client', 'stdio.js')))

const RUN = mkdtempSync(join(tmpdir(), 'vr-'))
const PORT = 18790 + Math.floor(Math.random() * 1000)
const env = { ...process.env, VOICE_REMOTE_RUN: RUN, VOICE_REMOTE_SOCKET: join(RUN, 'b.sock'), VOICE_REMOTE_PORT: String(PORT), VOICE_REMOTE_WHISPER_URL: 'http://127.0.0.1:9', VOICE_REMOTE_TTS: 'off' }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let bridge, token
function startBridge() {
  bridge = spawn('node', [join(ROOT, 'bridge', 'bridge.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  return sleep(400)
}

async function api(method, path, body, auth = true) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

async function session(name) {
  const cwd = join(RUN, name)
  mkdirSync(cwd, { recursive: true })
  const client = new Client({ name: `fake-claude-${name}`, version: '0' })
  const inbox = []
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') inbox.push(n.params) }
  const transport = new StdioClientTransport({ command: 'node', args: [join(ROOT, 'claude-integration', 'shim.mjs')], cwd, env, stderr: 'ignore' })
  await client.connect(transport)
  return { name, client, inbox, transport }
}

async function sidFor(label) {
  for (let i = 0; i < 30; i++) {
    const s = (await api('GET', '/sessions')).body.sessions.find(x => x.label === label)
    if (s) return s.sid
    await sleep(100)
  }
  throw new Error(`no session ${label}`)
}

async function waitState(id, want) {
  for (let i = 0; i < 30; i++) {
    const m = (await api('GET', `/messages/${id}`)).body
    if (m.state === want) return m
    await sleep(100)
  }
  throw new Error(`message ${id} never reached ${want}`)
}

let A, B, sidA, sidB
before(async () => {
  await startBridge()
  token = readFileSync(join(RUN, 'device-token'), 'utf8').trim()
  A = await session('alpha')
  B = await session('beta')
  sidA = await sidFor('alpha')
  sidB = await sidFor('beta')
})
after(async () => {
  await A?.client.close().catch(() => {})
  await B?.client.close().catch(() => {})
  bridge?.kill()
})

test('rejects requests without the device token', async () => {
  assert.equal((await api('GET', '/sessions', null, false)).status, 401)
})

test('two sessions get distinct ids', () => {
  assert.notEqual(sidA, sidB)
})

test('a message reaches only the selected session', async () => {
  const r = await api('POST', '/messages', { sid: sidA, text: 'explain what you changed', idempotency_key: 'k1' })
  assert.equal(r.status, 202)
  await waitState(r.body.message_id, 'delivered')
  assert.equal(A.inbox.length, 1)
  assert.equal(A.inbox[0].content, 'explain what you changed')
  assert.equal(A.inbox[0].meta.message_id, r.body.message_id)
  assert.equal(B.inbox.length, 0)
})

test('a retried request with the same key is not delivered twice', async () => {
  const first = (await api('GET', '/events?after=0')).body.events.find(e => e.type === 'delivered')
  const r = await api('POST', '/messages', { sid: sidA, text: 'explain what you changed', idempotency_key: 'k1' })
  assert.equal(r.status, 200)
  assert.equal(r.body.message_id, first.message_id)
  await sleep(200)
  assert.equal(A.inbox.length, 1)
})

test('the reply tool returns a reply event tied to the message', async () => {
  const id = A.inbox[0].meta.message_id
  const out = await A.client.callTool({ name: 'remote_reply', arguments: { message_id: id, text: 'I renamed two columns.' } })
  assert.equal(out.content[0].text, 'sent')
  await sleep(200)
  const reply = (await api('GET', '/events?after=0')).body.events.find(e => e.type === 'reply')
  assert.equal(reply.message_id, id)
  assert.equal(reply.sid, sidA)
  assert.equal(reply.text, 'I renamed two columns.')
})

test('a session cannot answer another session\'s message', async () => {
  const id = A.inbox[0].meta.message_id
  await B.client.callTool({ name: 'remote_reply', arguments: { message_id: id, text: 'not mine' } })
  await sleep(200)
  const replies = (await api('GET', '/events?after=0')).body.events.filter(e => e.type === 'reply')
  assert.equal(replies.length, 1)
})

test('an ended session is rejected as stale', async () => {
  await B.client.close()
  await sleep(300)
  const sessions = (await api('GET', '/sessions')).body.sessions.map(s => s.sid)
  assert.ok(!sessions.includes(sidB))
  const r = await api('POST', '/messages', { sid: sidB, text: 'hello', idempotency_key: 'k2' })
  assert.equal(r.status, 409)
})

test('a message caught by a bridge crash ends as unknown and is not resent', async () => {
  // Pause shim A so the message stays in "sending" when the bridge dies.
  const pid = A.transport.pid
  process.kill(pid, 'SIGSTOP')
  const r = await api('POST', '/messages', { sid: sidA, text: 'crash test', idempotency_key: 'k3' })
  assert.equal(r.status, 202)
  bridge.kill('SIGKILL')
  await sleep(200)
  process.kill(pid, 'SIGCONT')
  await startBridge()
  const m = (await api('GET', `/messages/${r.body.message_id}`)).body
  assert.equal(m.state, 'unknown')
  await sidFor('alpha') // shim reconnects under the same id
  await sleep(300)
  // The shim may have read the message from its socket buffer before the crash. Either way, never twice.
  assert.ok(A.inbox.filter(x => x.content === 'crash test').length <= 1)
})

test('rejects oversized text', async () => {
  const r = await api('POST', '/messages', { sid: sidA, text: 'x'.repeat(2001), idempotency_key: 'k4' })
  assert.equal(r.status, 400)
})
