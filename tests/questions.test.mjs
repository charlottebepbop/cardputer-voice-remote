// Milestone 4: Claude asks, the device answers. Real bridge and shims, MCP clients stand in for Claude Code.
// Run: node --test tests/questions.test.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SDK = join(ROOT, 'claude-integration', 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm')
const { Client } = await import(pathToFileURL(join(SDK, 'client', 'index.js')))
const { StdioClientTransport } = await import(pathToFileURL(join(SDK, 'client', 'stdio.js')))

const sleep = ms => new Promise(r => setTimeout(r, ms))

const fake = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ text: 'Use the blue one.' })) })
})
await new Promise(r => fake.listen(0, '127.0.0.1', r))

function setup(extraEnv = {}) {
  const RUN = mkdtempSync(join(tmpdir(), 'vr-q-'))
  const PORT = 20790 + Math.floor(Math.random() * 1000)
  const env = {
    ...process.env, VOICE_REMOTE_RUN: RUN, VOICE_REMOTE_SOCKET: join(RUN, 'b.sock'), VOICE_REMOTE_PORT: String(PORT),
    VOICE_REMOTE_WHISPER_URL: `http://127.0.0.1:${fake.address().port}`, VOICE_REMOTE_TTS: 'off', ...extraEnv,
  }
  const h = { RUN, PORT, env, bridge: null, token: null, clients: [] }
  h.start = async () => {
    h.bridge = spawn('node', [join(ROOT, 'bridge', 'bridge.mjs')], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    await sleep(400)
    h.token = readFileSync(join(RUN, 'device-token'), 'utf8').trim()
  }
  h.api = async (method, path, body, headers = {}) => {
    const raw = Buffer.isBuffer(body)
    const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method,
      headers: { Authorization: `Bearer ${h.token}`, 'Content-Type': raw ? 'audio/wav' : 'application/json', ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
  h.session = async name => {
    const cwd = join(RUN, name)
    mkdirSync(cwd, { recursive: true })
    const client = new Client({ name: `fake-${name}`, version: '0' })
    const inbox = []
    client.fallbackNotificationHandler = async n => { if (n.method === 'notifications/claude/channel') inbox.push(n.params) }
    await client.connect(new StdioClientTransport({ command: 'node', args: [join(ROOT, 'claude-integration', 'shim.mjs')], cwd, env, stderr: 'ignore' }))
    h.clients.push(client)
    let sid
    for (let i = 0; i < 30 && !sid; i++) {
      sid = (await h.api('GET', '/sessions')).body.sessions.find(x => x.label === name)?.sid
      if (!sid) await sleep(100)
    }
    return { client, inbox, sid }
  }
  h.question = async (label, text) => {
    for (let i = 0; i < 40; i++) {
      const found = (await h.api('GET', '/questions')).body.questions.find(x => x.label === label && x.text === text)
      if (found) return found
      await sleep(100)
    }
    throw new Error(`no question for ${label}`)
  }
  h.stop = async () => {
    for (const c of h.clients) await c.close().catch(() => {})
    h.bridge?.kill()
  }
  return h
}

const ask = (s, args, opts) => s.client.callTool({ name: 'remote_ask_user', arguments: args }, undefined, opts)
const text = r => r.content[0].text

function wav(seconds) {
  const data = Buffer.alloc(Math.round(seconds * 16000) * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(data.length, 40)
  return Buffer.concat([h, data])
}

async function doneJob(h, sid, request_id) {
  const r = await h.api('POST', '/voice/jobs', wav(1), { 'X-Target-Sid': sid, 'X-Request-Id': request_id })
  for (let i = 0; i < 30; i++) {
    const j = (await h.api('GET', `/voice/jobs/${r.body.job_id}`)).body
    if (j.status !== 'transcribing') return j
    await sleep(100)
  }
}

const H = setup()
let A, B
before(async () => {
  await H.start()
  A = await H.session('alpha')
  B = await H.session('beta')
})
after(async () => { await H.stop(); fake.close() })

test('a live answer completes the waiting tool call, once', async () => {
  const pending = ask(A, { question: 'Which colour should the button be?', short_screen_text: 'Button colour?' })
  const q = await H.question('alpha', 'Which colour should the button be?')
  assert.equal(q.screen_text, 'Button colour?')
  assert.equal(q.sid, A.sid)
  const job = await doneJob(H, A.sid, 'qa1')
  const first = await H.api('POST', `/questions/${q.question_id}/answers`, { text: job.transcript, idempotency_key: 'qa1', job_id: job.job_id })
  assert.equal(first.status, 202)
  const result = await pending
  assert.match(text(result), /Use the blue one\./)
  // Same request again: same message, not a second answer.
  const retry = await H.api('POST', `/questions/${q.question_id}/answers`, { text: job.transcript, idempotency_key: 'qa1', job_id: job.job_id })
  assert.equal(retry.status, 200)
  assert.equal(retry.body.message_id, first.body.message_id)
  // A different answer to the same question is refused.
  const second = await H.api('POST', `/questions/${q.question_id}/answers`, { text: 'red', idempotency_key: 'qa1b' })
  assert.equal(second.status, 409)
  assert.equal(second.body.status, 'answered')
  await sleep(200)
  assert.equal((await H.api('GET', `/messages/${first.body.message_id}`)).body.state, 'delivered')
  assert.equal(A.inbox.length, 0, 'a live answer is not also sent as a channel message')
  assert.ok(!(await H.api('GET', '/questions')).body.questions.some(x => x.question_id === q.question_id))
})

test('an answer recorded for another session is refused', async () => {
  const pending = ask(A, { question: 'Ship it?', wait_seconds: 5 })
  const q = await H.question('alpha', 'Ship it?')
  const job = await doneJob(H, B.sid, 'qa2')
  const r = await H.api('POST', `/questions/${q.question_id}/answers`, { text: job.transcript, idempotency_key: 'qa2', job_id: job.job_id })
  assert.equal(r.status, 409)
  await pending
})

test('after the tool call times out, the answer arrives as a late channel message', async () => {
  const before = A.inbox.length
  const r = await ask(A, { question: 'Merge now?', wait_seconds: 5 })
  assert.match(text(r), /No answer yet/)
  const q = await H.question('alpha', 'Merge now?')
  const a = await H.api('POST', `/questions/${q.question_id}/answers`, { text: 'Yes, merge.', idempotency_key: 'qa3' })
  assert.equal(a.status, 202)
  await sleep(300)
  const late = A.inbox.at(-1)
  assert.equal(A.inbox.length, before + 1)
  assert.equal(late.content, 'Yes, merge.')
  assert.equal(late.meta.question_id, q.question_id)
  assert.equal(late.meta.kind, 'late_answer')
  assert.equal(B.inbox.length, 0)
})

test('a cancelled tool call also turns the answer into a late message', async () => {
  const ac = new AbortController()
  const pending = ask(A, { question: 'Deploy?' }, { signal: ac.signal }).catch(e => e)
  const q = await H.question('alpha', 'Deploy?')
  ac.abort()
  await pending
  await sleep(200)
  await H.api('POST', `/questions/${q.question_id}/answers`, { text: 'No.', idempotency_key: 'qa4' })
  await sleep(300)
  assert.equal(A.inbox.at(-1).meta.question_id, q.question_id)
})

test('a question survives a bridge restart and still completes its waiting call', async () => {
  const pending = ask(A, { question: 'Keep going?', wait_seconds: 30 }, { timeout: 60_000 })
  const q = await H.question('alpha', 'Keep going?')
  H.bridge.kill()
  await sleep(300)
  await H.start()
  const again = await H.question('alpha', 'Keep going?') // shims reconnect within about 2 s
  assert.equal(again.question_id, q.question_id)
  const a = await H.api('POST', `/questions/${q.question_id}/answers`, { text: 'Yes.', idempotency_key: 'qa5' })
  assert.equal(a.status, 202)
  assert.match(text(await pending), /Yes\./)
})

test('ending the session cancels its open questions', async () => {
  const C = await H.session('gamma')
  ask(C, { question: 'Still there?' }).catch(() => {})
  const q = await H.question('gamma', 'Still there?')
  await C.client.close()
  await sleep(300)
  const r = await H.api('POST', `/questions/${q.question_id}/answers`, { text: 'Yes.', idempotency_key: 'qa6' })
  assert.equal(r.status, 409)
  assert.equal(r.body.status, 'cancelled')
  const closed = (await H.api('GET', '/events?after=0')).body.events.find(e => e.type === 'question_closed' && e.message_id === q.question_id)
  assert.equal(closed.text, 'cancelled')
})

test('an expired question is refused and leaves the inbox', async () => {
  const X = setup({ VOICE_REMOTE_QUESTION_TTL_H: String(1 / 3600) }) // one second
  await X.start()
  try {
    const S = await X.session('delta')
    ask(S, { question: 'Quick one?', wait_seconds: 5 }).catch(() => {})
    const q = await X.question('delta', 'Quick one?')
    await sleep(1500)
    const r = await X.api('POST', `/questions/${q.question_id}/answers`, { text: 'Yes.', idempotency_key: 'qa7' })
    assert.equal(r.status, 409)
    assert.equal(r.body.status, 'expired')
    assert.equal((await X.api('GET', '/questions')).body.questions.length, 0)
  } finally { await X.stop() }
})
