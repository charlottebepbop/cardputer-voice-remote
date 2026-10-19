// Milestone 5: status, token revocation, clean-up and vocabulary hints.
// Run: node --test tests/daily.test.mjs
import { test, before, after } from 'node:test'
import { waitUp } from './wait-up.mjs'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const SDK = join(ROOT, 'claude-integration', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
const { Client } = await import(pathToFileURL(join(SDK, 'client', 'index.js')))
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'client', 'stdio.js')))

let prompt = ''
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c.toString('latin1') })
  req.on('end', () => { prompt = body; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'ok' })) })
})
await new Promise(r => fake.listen(0, '127.0.0.1', r))

const RUN = mkdtempSync(join(tmpdir(), 'vr-d-'))
const PORT = 21790 + Math.floor(Math.random() * 1000)
const env = {
  ...process.env, VOICE_REMOTE_RUN: RUN, VOICE_REMOTE_SOCKET: join(RUN, 'b.sock'), VOICE_REMOTE_PORT: String(PORT),
  VOICE_REMOTE_WHISPER_URL: `http://127.0.0.1:${fake.address().port}`, VOICE_REMOTE_TTS: 'off',
}
let bridge
const tokenNow = () => readFileSync(join(RUN, 'device-token'), 'utf8').trim()
async function api(path, token = tokenNow(), opts = {}) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, { ...opts, headers: { Authorization: `Bearer ${token}`, ...opts.headers } })
  return { status: res.status, body: await res.json() }
}
function wav(seconds) {
  const data = Buffer.alloc(Math.round(seconds * 16000) * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

before(async () => {
  bridge = spawn('node', [join(ROOT, 'bridge', 'bridge.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await waitUp(PORT)
})
after(() => { bridge?.kill(); fake.close() })

test('status reports whisper, sessions and uptime', async () => {
  const r = await api('/status')
  assert.equal(r.status, 200)
  assert.equal(r.body.whisper, 'ok')
  assert.equal(r.body.live_sessions, 0)
  assert.equal(typeof r.body.uptime_s, 'number')
})

test('revoke-token stops the old token at once, without a restart', async () => {
  const old = tokenNow()
  // Run the real script against a copy of bin/, so it rotates the test token, not the live one.
  const root = mkdtempSync(join(tmpdir(), 'vr-root-'))
  cpSync(join(ROOT, 'bin'), join(root, 'bin'), { recursive: true })
  mkdirSync(join(root, 'run'))
  writeFileSync(join(root, 'run', 'device-token'), old + '\n')
  const out = execFileSync(join(root, 'bin', 'revoke-token')).toString()
  assert.match(out, /--token-only/)
  const fresh = readFileSync(join(root, 'run', 'device-token'), 'utf8').trim()
  assert.notEqual(fresh, old)
  await sleep(20)
  writeFileSync(join(RUN, 'device-token'), fresh + '\n', { mode: 0o600 })
  assert.equal((await api('/sessions', old)).status, 401)
  assert.equal((await api('/sessions', fresh)).status, 200)
})

test('words in run/vocab.txt reach whisper', async () => {
  writeFileSync(join(RUN, 'vocab.txt'), '# names\nAlice\nBob\n')
  const cwd = join(RUN, 'eps')
  mkdirSync(cwd, { recursive: true })
  const client = new Client({ name: 'fake', version: '0' })
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(ROOT, 'claude-integration', 'shim.mjs')], cwd, env, stderr: 'ignore' }))
  try {
    let sid
    for (let i = 0; i < 30 && !sid; i++) { sid = (await api('/sessions')).body.sessions[0]?.sid; if (!sid) await sleep(100) }
    const r = await api('/voice/jobs', tokenNow(), { method: 'POST', body: wav(1), headers: { 'X-Target-Sid': sid, 'X-Request-Id': 'v1', 'Content-Type': 'audio/wav' } })
    assert.equal(r.status, 202)
    for (let i = 0; i < 30 && !prompt; i++) await sleep(100)
    assert.match(prompt, /Claude, Alice, Bob/)
    assert.doesNotMatch(prompt, /# names/)
  } finally { await client.close() }
})

test('clean-up deletes old rows but keeps the newest event', async () => {
  bridge.kill()
  await sleep(200)
  const db = new DatabaseSync(join(RUN, 'bridge.db'))
  const old = '2020-01-01T00:00:00.000Z'
  db.prepare(`INSERT INTO messages (message_id,sid,idempotency_key,text,state,created_at,updated_at) VALUES ('m-old','s','k-old','t','delivered',?,?)`).run(old, old)
  db.prepare(`INSERT INTO messages (message_id,sid,idempotency_key,text,state,created_at,updated_at) VALUES ('m-new','s','k-new','t','delivered',?,?)`).run(new Date().toISOString(), new Date().toISOString())
  db.prepare(`DELETE FROM events`).run()
  db.prepare(`INSERT INTO events (sid,type,created_at) VALUES ('s','reply',?)`).run(old)
  db.prepare(`INSERT INTO events (sid,type,created_at) VALUES ('s','reply',?)`).run(old)
  const top = db.prepare(`SELECT MAX(event_id) id FROM events`).get().id
  db.close()
  bridge = spawn('node', [join(ROOT, 'bridge', 'bridge.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await waitUp(PORT)
  const after = new DatabaseSync(join(RUN, 'bridge.db'))
  const ids = after.prepare(`SELECT message_id FROM messages`).all().map(r => r.message_id)
  const events = after.prepare(`SELECT event_id FROM events`).all().map(r => r.event_id)
  after.close()
  assert.deepEqual(ids, ['m-new'])
  assert.ok(events.includes(top), 'newest event kept, so the device cursor never goes backwards')
  assert.equal((await api('/events?after=0')).body.latest >= top, true)
})
