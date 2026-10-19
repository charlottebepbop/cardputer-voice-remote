// Voice upload and transcription, with a fake whisper-server.
// Run: node --test tests/voice.test.mjs
import { test, before, after } from 'node:test'
import { waitUp } from './wait-up.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = join(ROOT, 'claude-integration', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
const { Client } = await import(pathToFileURL(join(SDK, 'client', 'index.js')))
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'client', 'stdio.js')))

const RUN = mkdtempSync(join(tmpdir(), 'vr-voice-'))
const PORT = 19790 + Math.floor(Math.random() * 1000)
const sleep = ms => new Promise(r => setTimeout(r, ms))

let fakeReply = { status: 200, body: { text: ' Explain what you changed.\n' } }
let prompts = []
const fake = http.createServer((req, res) => {
  let body = ''
  req.on('data', c => { body += c.toString('latin1') })
  req.on('end', () => {
    prompts.push(body.includes('Claude'))
    res.writeHead(fakeReply.status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(fakeReply.body))
  })
})
await new Promise(r => fake.listen(0, '127.0.0.1', r))

const env = {
  ...process.env, VOICE_REMOTE_RUN: RUN, VOICE_REMOTE_SOCKET: join(RUN, 'b.sock'), VOICE_REMOTE_PORT: String(PORT),
  VOICE_REMOTE_WHISPER_URL: `http://127.0.0.1:${fake.address().port}`,
}

function wav(seconds, { rate = 16000, channels = 1, extraChunk = false } = {}) {
  const data = Buffer.alloc(Math.round(seconds * rate) * 2 * channels)
  const extra = extraChunk ? Buffer.concat([Buffer.from('LIST'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO')]) : Buffer.alloc(0)
  const h = Buffer.alloc(36)
  h.write('RIFF', 0); h.writeUInt32LE(36 + extra.length + 8 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22)
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2 * channels, 28); h.writeUInt16LE(2 * channels, 32); h.writeUInt16LE(16, 34)
  const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(data.length, 4)
  return Buffer.concat([h, extra, dh, data])
}

let bridge, token, A, B, sidA, sidB
async function api(method, path, body, headers = {}) {
  const raw = Buffer.isBuffer(body)
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': raw ? 'audio/wav' : 'application/json', ...headers },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}
async function session(name) {
  const cwd = join(RUN, name)
  mkdirSync(cwd, { recursive: true })
  const client = new Client({ name: `fake-${name}`, version: '0' })
  const inbox = []
  client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') inbox.push(n.params) }
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(ROOT, 'claude-integration', 'shim.mjs')], cwd, env, stderr: 'ignore' }))
  return { client, inbox }
}
async function sidFor(label) {
  for (let i = 0; i < 30; i++) {
    const s = (await api('GET', '/sessions')).body.sessions.find(x => x.label === label)
    if (s) return s.sid
    await sleep(100)
  }
  throw new Error(`no session ${label}`)
}
async function job(id) {
  for (let i = 0; i < 30; i++) {
    const j = (await api('GET', `/voice/jobs/${id}`)).body
    if (j.status !== 'transcribing') return j
    await sleep(100)
  }
  throw new Error('job stuck')
}
const upload = (sid, body, request_id) => api('POST', '/voice/jobs', body, { 'X-Target-Sid': sid, 'X-Request-Id': request_id })

before(async () => {
  bridge = spawn('node', [join(ROOT, 'bridge', 'bridge.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  await waitUp(PORT)
  token = readFileSync(join(RUN, 'device-token'), 'utf8').trim()
  A = await session('alpha'); B = await session('beta')
  sidA = await sidFor('alpha'); sidB = await sidFor('beta')
})
after(async () => {
  await A?.client.close().catch(() => {}); await B?.client.close().catch(() => {})
  bridge?.kill(); fake.close()
})

test('a recording is transcribed and its audio deleted', async () => {
  const r = await upload(sidA, wav(2), 'r1')
  assert.equal(r.status, 202)
  const j = await job(r.body.job_id)
  assert.equal(j.status, 'done')
  assert.equal(j.transcript, 'Explain what you changed.')
  assert.equal(prompts.at(-1), true, 'vocabulary hints sent')
  assert.deepEqual(readdirSync(join(RUN, 'audio')), [])
})

test('the same request id is not transcribed twice', async () => {
  const n = prompts.length
  const r = await upload(sidA, wav(2), 'r1')
  assert.equal(r.status, 200)
  assert.equal(prompts.length, n)
})

test('extra RIFF chunks before data are accepted', async () => {
  const r = await upload(sidA, wav(1, { extraChunk: true }), 'r2')
  assert.equal(r.status, 202)
})

test('wrong format, too short and oversized audio are rejected', async () => {
  assert.equal((await upload(sidA, wav(1, { rate: 44100 }), 'r3')).status, 415)
  assert.equal((await upload(sidA, wav(1, { channels: 2 }), 'r4')).status, 415)
  assert.equal((await upload(sidA, wav(0.1), 'r5')).status, 415)
  assert.equal((await upload(sidA, Buffer.from('hello world!'), 'r6')).status, 415)
  const big = await upload(sidA, wav(32), 'r7').catch(() => ({ status: 413 }))
  assert.equal(big.status, 413)
})

test('upload to an unknown session is rejected', async () => {
  assert.equal((await upload('nope', wav(1), 'r8')).status, 409)
})

test('a confirmed transcript reaches the session it was recorded for', async () => {
  const r = await upload(sidA, wav(2), 'r9')
  const j = await job(r.body.job_id)
  const m = await api('POST', '/messages', { sid: sidA, text: j.transcript, idempotency_key: 'r9', job_id: j.job_id })
  assert.equal(m.status, 202)
  await sleep(300)
  assert.equal(A.inbox.at(-1).content, 'Explain what you changed.')
  assert.equal(B.inbox.length, 0)
})

test('a transcript cannot be sent to a different session than it was recorded for', async () => {
  const r = await upload(sidA, wav(2), 'r10')
  const j = await job(r.body.job_id)
  const m = await api('POST', '/messages', { sid: sidB, text: j.transcript, idempotency_key: 'r10', job_id: j.job_id })
  assert.equal(m.status, 409)
  await sleep(200)
  assert.equal(B.inbox.length, 0)
})

test('whisper failure and silence end the job as failed', async () => {
  fakeReply = { status: 500, body: {} }
  assert.equal((await job((await upload(sidA, wav(1), 'r11')).body.job_id)).status, 'failed')
  fakeReply = { status: 200, body: { text: '  ' } }
  const j = await job((await upload(sidA, wav(1), 'r12')).body.job_id)
  assert.equal(j.status, 'failed')
  assert.equal(j.error, 'nothing heard')
  const m = await api('POST', '/messages', { sid: sidA, text: 'x', idempotency_key: 'r12', job_id: j.job_id })
  assert.equal(m.status, 409)
})

test('a reply is turned into speech the device can download', async () => {
  fakeReply = { status: 200, body: { text: 'Say banana.' } }
  const r = await upload(sidA, wav(1), 'r13')
  const j = await job(r.body.job_id)
  const m = await api('POST', '/messages', { sid: sidA, text: j.transcript, idempotency_key: 'r13', job_id: j.job_id })
  await sleep(300)
  await A.client.callTool({ name: 'remote_reply', arguments: { message_id: m.body.message_id, text: '-Banana. Done.' } })
  let reply
  for (let i = 0; i < 50 && !reply; i++) {
    await sleep(100)
    reply = (await api('GET', '/events?after=0')).body.events.find(e => e.type === 'reply' && e.message_id === m.body.message_id)
  }
  assert.ok(reply?.audio_id, 'reply has audio')
  const res = await fetch(`http://127.0.0.1:${PORT}/audio/${reply.audio_id}`, { headers: { Authorization: `Bearer ${token}` } })
  assert.equal(res.status, 200)
  const buf = Buffer.from(await res.arrayBuffer())
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF')
  assert.equal(buf.readUInt32LE(24), 16000)
  const noAuth = await fetch(`http://127.0.0.1:${PORT}/audio/${reply.audio_id}`)
  assert.equal(noAuth.status, 401)
})
