#!/usr/bin/env node
// Host bridge. Shims (one per Claude Code session) connect on a Unix socket.
// The device talks HTTPS on the LAN (VOICE_REMOTE_LAN=1) with a bearer token.
// Local tools use plain HTTP on 127.0.0.1.
import { DatabaseSync } from 'node:sqlite'
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, chmodSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import https from 'node:https'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import http from 'node:http'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUN = process.env.VOICE_REMOTE_RUN ?? join(ROOT, 'run')
const SOCKET = process.env.VOICE_REMOTE_SOCKET ?? join(RUN, 'bridge.sock')
const HOST = process.env.VOICE_REMOTE_HOST ?? '127.0.0.1'
const PORT = Number(process.env.VOICE_REMOTE_PORT ?? 8790)
const TEXT_MAX = 2000
const LAN = process.env.VOICE_REMOTE_LAN === '1'
const LAN_PORT = Number(process.env.VOICE_REMOTE_LAN_PORT ?? 8443)
// Wi-Fi only. 0.0.0.0 would also listen on VPN interfaces such as Tailscale.
const LAN_IF = process.env.VOICE_REMOTE_LAN_IF ?? 'en0'
// Optional: comma-separated device IPs. Others are dropped before the token check.
const ALLOW_IPS = (process.env.VOICE_REMOTE_ALLOW_IPS ?? '').split(',').map(x => x.trim()).filter(Boolean)
const WHISPER_PORT = 8791
const WHISPER_URL = process.env.VOICE_REMOTE_WHISPER_URL ?? `http://127.0.0.1:${WHISPER_PORT}`
const MODEL = process.env.VOICE_REMOTE_MODEL ?? join(ROOT, 'models', 'ggml-small-q5_1.bin')
const RATE = 16000
const AUDIO_MAX = 44 + 31 * RATE * 2 // 31 s of 16 kHz mono PCM; the device stops at 30 s
const AUDIO_TTL_MS = 10 * 60 * 1000
// whisper.cpp spells these better when it is told to expect them.
const VOCAB_BASE = 'Claude'
const AUDIO_CAP = 50 * 1024 * 1024
const RETENTION_DAYS = Number(process.env.VOICE_REMOTE_RETENTION_DAYS ?? 7)
const STARTED = Date.now()
const AUDIO = join(RUN, 'audio')
const TTS_MAX = 1100 * 1024 // fits the device's flash area next to nothing else
const QUESTION_TTL_H = Number(process.env.VOICE_REMOTE_QUESTION_TTL_H ?? 24)

mkdirSync(RUN, { recursive: true, mode: 0o700 })
chmodSync(RUN, 0o700)

const tokenFile = join(RUN, 'device-token')
if (!existsSync(tokenFile)) writeFileSync(tokenFile, randomBytes(24).toString('hex') + '\n', { mode: 0o600 })
// Re-read when bin/revoke-token rewrites the file, so the old token stops working without a restart.
let token = { mtime: 0, buf: null }
function currentToken() {
  const m = statSync(tokenFile).mtimeMs
  if (m !== token.mtime) token = { mtime: m, buf: Buffer.from(readFileSync(tokenFile, 'utf8').trim()) }
  return token.buf
}

// One word or name per line in run/vocab.txt, added to the built-in list.
function vocab() {
  const f = join(RUN, 'vocab.txt')
  if (!existsSync(f)) return VOCAB_BASE
  const extra = readFileSync(f, 'utf8').split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#'))
  return [VOCAB_BASE, ...extra].join(', ').slice(0, 800)
}

mkdirSync(AUDIO, { recursive: true, mode: 0o700 })
for (const f of readdirSync(AUDIO)) unlinkSync(join(AUDIO, f))
const db = new DatabaseSync(process.env.VOICE_REMOTE_DB ?? join(RUN, 'bridge.db'))
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY, label TEXT, branch TEXT, cwd TEXT, pid INTEGER,
    state TEXT NOT NULL, connected_at TEXT, last_seen TEXT);
  CREATE TABLE IF NOT EXISTS messages (
    message_id TEXT PRIMARY KEY, sid TEXT NOT NULL, idempotency_key TEXT UNIQUE NOT NULL,
    text TEXT NOT NULL, state TEXT NOT NULL, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT, sid TEXT, type TEXT NOT NULL,
    message_id TEXT, text TEXT, created_at TEXT, audio_id TEXT);
  CREATE TABLE IF NOT EXISTS voice_jobs (
    job_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, sid TEXT NOT NULL,
    status TEXT NOT NULL, transcript TEXT, error TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE IF NOT EXISTS questions (
    question_id TEXT PRIMARY KEY, sid TEXT NOT NULL, text TEXT NOT NULL, screen_text TEXT,
    status TEXT NOT NULL, waiting INTEGER NOT NULL DEFAULT 0, answer_message_id TEXT, audio_id TEXT,
    created_at TEXT, expires_at TEXT, updated_at TEXT);
`)

if (!db.prepare(`SELECT 1 FROM pragma_table_info('events') WHERE name='audio_id'`).get()) db.exec(`ALTER TABLE events ADD COLUMN audio_id TEXT`)
if (!db.prepare(`SELECT 1 FROM pragma_table_info('messages') WHERE name='question_id'`).get()) db.exec(`ALTER TABLE messages ADD COLUMN question_id TEXT`)

const now = () => new Date().toISOString()
const live = new Map() // sid -> socket

// Startup reconciliation. A message caught mid-send may or may not have reached its session.
db.prepare(`UPDATE messages SET state='unknown', updated_at=? WHERE state IN ('queued','sending')`).run(now())
db.prepare(`UPDATE sessions SET state='ended' WHERE state='live'`).run()
db.prepare(`UPDATE voice_jobs SET status='failed', error='bridge restarted', updated_at=? WHERE status='transcribing'`).run(now())
// Questions stay open: their sessions reconnect and say which tool calls still wait.
db.prepare(`UPDATE questions SET waiting=0 WHERE status='open'`).run()

const q = {
  upsertSession: db.prepare(`INSERT INTO sessions (sid,label,branch,cwd,pid,state,connected_at,last_seen)
    VALUES (?,?,?,?,?,'live',?,?) ON CONFLICT(sid) DO UPDATE SET state='live', last_seen=excluded.last_seen`),
  endSession: db.prepare(`UPDATE sessions SET state='ended', last_seen=? WHERE sid=?`),
  liveSessions: db.prepare(`SELECT sid,label,branch,cwd,state,last_seen FROM sessions WHERE state='live' ORDER BY connected_at`),
  msgById: db.prepare(`SELECT message_id,sid,state,created_at,updated_at FROM messages WHERE message_id=?`),
  msgByKey: db.prepare(`SELECT message_id,sid,state FROM messages WHERE idempotency_key=?`),
  insertMsg: db.prepare(`INSERT INTO messages (message_id,sid,idempotency_key,text,state,created_at,updated_at) VALUES (?,?,?,?,'sending',?,?)`),
  setMsg: db.prepare(`UPDATE messages SET state=?, updated_at=? WHERE message_id=? AND sid=?`),
  sendingFor: db.prepare(`SELECT message_id FROM messages WHERE sid=? AND state='sending'`),
  addEvent: db.prepare(`INSERT INTO events (sid,type,message_id,text,created_at,audio_id) VALUES (?,?,?,?,?,?)`),
  jobById: db.prepare(`SELECT job_id,request_id,sid,status,transcript,error FROM voice_jobs WHERE job_id=?`),
  jobByRequest: db.prepare(`SELECT job_id,request_id,sid,status,transcript,error FROM voice_jobs WHERE request_id=?`),
  insertJob: db.prepare(`INSERT INTO voice_jobs (job_id,request_id,sid,status,created_at,updated_at) VALUES (?,?,?,'transcribing',?,?)`),
  finishJob: db.prepare(`UPDATE voice_jobs SET status=?, transcript=?, error=?, updated_at=? WHERE job_id=?`),
  latestEvent: db.prepare(`SELECT MAX(event_id) AS id FROM events`),
  eventsAfter: db.prepare(`SELECT event_id,sid,type,message_id,text,created_at,audio_id FROM events WHERE event_id>? ORDER BY event_id LIMIT 50`),
  insertMsgQ: db.prepare(`INSERT INTO messages (message_id,sid,idempotency_key,text,state,created_at,updated_at,question_id) VALUES (?,?,?,?,'sending',?,?,?)`),
  msgByKeyQ: db.prepare(`SELECT message_id,sid,state,question_id FROM messages WHERE idempotency_key=?`),
  insertQ: db.prepare(`INSERT OR IGNORE INTO questions (question_id,sid,text,screen_text,status,waiting,created_at,expires_at,updated_at) VALUES (?,?,?,?,'open',1,?,?,?)`),
  qById: db.prepare(`SELECT * FROM questions WHERE question_id=?`),
  setQAudio: db.prepare(`UPDATE questions SET audio_id=? WHERE question_id=?`),
  setWaiting: db.prepare(`UPDATE questions SET waiting=? WHERE question_id=? AND sid=?`),
  clearWaiting: db.prepare(`UPDATE questions SET waiting=0 WHERE sid=? AND status='open'`),
  answerQ: db.prepare(`UPDATE questions SET status='answered', answer_message_id=?, updated_at=? WHERE question_id=? AND status='open'`),
  closeQ: db.prepare(`UPDATE questions SET status=?, updated_at=? WHERE question_id=? AND status='open'`),
  openAudio: db.prepare(`SELECT audio_id FROM questions WHERE status='open' AND audio_id IS NOT NULL`),
  openQFor: db.prepare(`SELECT question_id FROM questions WHERE sid=? AND status='open'`),
  expiredQ: db.prepare(`SELECT question_id,sid FROM questions WHERE status='open' AND expires_at<?`),
  inbox: db.prepare(`SELECT q.question_id,q.sid,s.label,s.branch,q.text,q.screen_text,q.audio_id,q.created_at,q.expires_at
    FROM questions q JOIN sessions s ON s.sid=q.sid WHERE q.status='open' AND s.state='live' ORDER BY q.created_at`),
}

function event(sid, type, message_id = null, text = null, audio_id = null) {
  q.addEvent.run(sid, type, message_id, text, now(), audio_id)
}

function closeQuestion(question_id, sid, status) {
  if (q.closeQ.run(status, now(), question_id).changes) event(sid, 'question_closed', question_id, status)
}

setInterval(() => {
  for (const { question_id, sid } of q.expiredQ.all(now())) closeQuestion(question_id, sid, 'expired')
}, 30_000).unref()

// An open question keeps its audio, because it can wait in the inbox for hours.
// Past the cap, the oldest files go first, kept or not.
function sweepAudio() {
  const keep = new Set(q.openAudio.all().map(r => `${r.audio_id}.wav`))
  let files = []
  for (const f of readdirSync(AUDIO)) {
    const p = join(AUDIO, f)
    const st = statSync(p)
    if (!keep.has(f) && Date.now() - st.mtimeMs > AUDIO_TTL_MS) unlinkSync(p)
    else files.push({ p, size: st.size, mtime: st.mtimeMs })
  }
  files.sort((a, b) => a.mtime - b.mtime)
  let total = files.reduce((n, f) => n + f.size, 0)
  while (total > AUDIO_CAP && files.length) { const f = files.shift(); unlinkSync(f.p); total -= f.size }
  return total
}
setInterval(sweepAudio, 60_000).unref()

function cleanup() {
  const cut = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString()
  const n = [
    db.prepare(`DELETE FROM messages WHERE created_at<? AND state NOT IN ('queued','sending')`).run(cut).changes,
    db.prepare(`DELETE FROM voice_jobs WHERE created_at<? AND status<>'transcribing'`).run(cut).changes,
    db.prepare(`DELETE FROM questions WHERE created_at<? AND status<>'open'`).run(cut).changes,
    db.prepare(`DELETE FROM sessions WHERE state='ended' AND last_seen<?`).run(cut).changes,
    // Keep the newest event so the cursor never goes backwards.
    db.prepare(`DELETE FROM events WHERE created_at<? AND event_id<(SELECT MAX(event_id) FROM events)`).run(cut).changes,
  ]
  return n.reduce((a, b) => a + b, 0)
}
cleanup()
setInterval(cleanup, 3600_000).unref()

// --- shim side -------------------------------------------------------------
if (existsSync(SOCKET)) unlinkSync(SOCKET)
const shimServer = net.createServer(sock => {
  let sid = null
  let buf = ''
  sock.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      if (msg.type === 'hello' && !sid && typeof msg.sid === 'string') {
        sid = msg.sid
        live.get(sid)?.destroy()
        live.set(sid, sock)
        q.upsertSession.run(sid, msg.label ?? '', msg.branch ?? '', msg.cwd ?? '', msg.pid ?? null, now(), now())
        event(sid, 'session_live')
      } else if (!sid) {
        continue
      } else if (msg.type === 'delivered') {
        q.setMsg.run('delivered', now(), msg.message_id, sid)
        event(sid, 'delivered', msg.message_id, msg.mode ?? null)
      } else if (msg.type === 'duplicate') {
        event(sid, 'duplicate_blocked', msg.message_id)
      } else if (msg.type === 'ask' && typeof msg.question_id === 'string' && typeof msg.text === 'string') {
        const t = now()
        const expires = new Date(Date.now() + QUESTION_TTL_H * 3600_000).toISOString()
        const screen = String(msg.screen_text ?? '').slice(0, 80) || msg.text.slice(0, 80)
        if (q.insertQ.run(msg.question_id, sid, msg.text.slice(0, TEXT_MAX), screen, t, expires, t).changes) {
          speak(msg.text).then(audio_id => {
            if (audio_id) q.setQAudio.run(audio_id, msg.question_id)
            event(sid, 'question', msg.question_id, screen, audio_id)
          })
        }
      } else if (msg.type === 'ask_waiting' && Array.isArray(msg.question_ids)) {
        q.clearWaiting.run(sid)
        for (const id of msg.question_ids) q.setWaiting.run(1, String(id), sid)
      } else if (msg.type === 'ask_stopped') {
        q.setWaiting.run(0, String(msg.question_id), sid)
      } else if (msg.type === 'reply') {
        // A session may only answer its own messages.
        const m = q.msgById.get(msg.message_id)
        if (m && m.sid === sid) {
          const text = String(msg.text)
          speak(text).then(audio_id => event(sid, 'reply', msg.message_id, text, audio_id))
        }
      }
    }
  })
  sock.on('error', () => {})
  sock.on('close', () => {
    if (!sid || live.get(sid) !== sock) return
    live.delete(sid)
    q.endSession.run(now(), sid)
    for (const { message_id } of q.sendingFor.all(sid)) q.setMsg.run('unknown', now(), message_id, sid)
    for (const { question_id } of q.openQFor.all(sid)) closeQuestion(question_id, sid, 'cancelled')
    event(sid, 'session_ended')
  })
})
shimServer.listen(SOCKET, () => chmodSync(SOCKET, 0o600))

// --- device side -----------------------------------------------------------
function authed(req) {
  const got = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer /, ''))
  const t = currentToken()
  return got.length === t.length && timingSafeEqual(got, t)
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readRaw(req, limit) {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw Object.assign(new Error('too large'), { status: 413 })
  let size = 0
  const parts = []
  for await (const c of req) {
    size += c.length
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 })
    parts.push(c)
  }
  return Buffer.concat(parts)
}

async function readBody(req, limit = 16 * 1024) {
  return JSON.parse((await readRaw(req, limit)).toString('utf8') || '{}')
}

// Walks the RIFF chunks instead of assuming a 44-byte header.
function checkWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'not a WAV file'
  let off = 12, fmt = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(off + 8), ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
    } else if (id === 'data') {
      if (!fmt) return 'data before fmt'
      if (fmt.format !== 1 || fmt.ch !== 1 || fmt.bits !== 16 || fmt.rate !== RATE) return 'need 16 kHz mono 16-bit PCM'
      if (len < RATE / 5 * 2) return 'recording too short'
      if (off + 8 + len > buf.length) return 'truncated'
      return null
    }
    off += 8 + len + (len & 1)
  }
  return 'no data chunk'
}

// Returns an audio id, or null so the device shows text only.
async function speak(text) {
  if (process.env.VOICE_REMOTE_TTS === 'off') return null
  const audio_id = randomUUID()
  const txt = join(AUDIO, `${audio_id}.txt`)
  const out = join(AUDIO, `${audio_id}.wav`)
  writeFileSync(txt, text, { mode: 0o600 })
  try {
    // -f reads the text from a file, so a reply starting with "-" is not taken as an option.
    await new Promise((resolve, reject) => {
      const p = spawn('say', ['-r', '190', '-o', out, '--file-format=WAVE', `--data-format=LEI16@${RATE}`, '-f', txt], { stdio: 'ignore' })
      const t = setTimeout(() => p.kill(), 20_000)
      p.on('error', reject)
      p.on('exit', code => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(`say exit ${code}`)) })
    })
    if (statSync(out).size > TTS_MAX) { unlinkSync(out); return null }
    return audio_id
  } catch {
    try { unlinkSync(out) } catch {}
    return null
  } finally {
    try { unlinkSync(txt) } catch {}
  }
}

async function transcribe(job_id, path) {
  try {
    const form = new FormData()
    form.append('file', new Blob([readFileSync(path)], { type: 'audio/wav' }), 'rec.wav')
    form.append('response_format', 'json')
    form.append('prompt', vocab())
    const r = await fetch(`${WHISPER_URL}/inference`, { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) })
    if (!r.ok) throw new Error(`whisper HTTP ${r.status}`)
    const text = String((await r.json()).text ?? '').trim()
    if (!text) throw new Error('nothing heard')
    q.finishJob.run('done', text.slice(0, TEXT_MAX), null, now(), job_id)
  } catch (e) {
    q.finishJob.run('failed', null, e.message, now(), job_id)
  } finally {
    try { unlinkSync(path) } catch {}
  }
}

// The device sends its boot count and Wi-Fi drop count on every call. A change means it
// rebooted or lost Wi-Fi, so log only the change. Polling would fill the file otherwise.
let deviceKey = ''
function logDevice(req) {
  const h = req.headers
  if (h['x-boot'] === undefined) return
  const key = `${h['x-boot']}|${h['x-drops']}`
  if (key === deviceKey) return
  deviceKey = key
  const line = `${new Date().toISOString()} boot=${h['x-boot']} reset=${h['x-reset']} up=${h['x-up']}s drops=${h['x-drops']} last_drop_reason=${h['x-drop-reason']} first_call=${req.method} ${req.url.split('?')[0]}\n`
  try { appendFileSync(join(RUN, 'device-events.log'), line) } catch {}
}

async function handler(req, res) {
  try {
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' })
    logDevice(req)
    const url = new URL(req.url, 'http://x')

    if (req.method === 'GET' && url.pathname === '/sessions') {
      return json(res, 200, { sessions: q.liveSessions.all().map(s => ({ ...s, short: s.sid.slice(0, 4) })) })
    }

    if (req.method === 'POST' && url.pathname === '/voice/jobs') {
      const request_id = req.headers['x-request-id']
      const sid = req.headers['x-target-sid']
      if (typeof request_id !== 'string' || typeof sid !== 'string') return json(res, 400, { error: 'X-Request-Id and X-Target-Sid are required' })
      const body = await readRaw(req, AUDIO_MAX)
      const prior = q.jobByRequest.get(request_id)
      if (prior) return json(res, prior.sid === sid ? 200 : 409, prior)
      if (!live.has(sid)) return json(res, 409, { error: 'session not live', sid })
      const bad = checkWav(body)
      if (bad) return json(res, 415, { error: bad })
      const job_id = randomUUID()
      const path = join(AUDIO, `${job_id}.wav`)
      writeFileSync(path, body, { mode: 0o600 })
      q.insertJob.run(job_id, request_id, sid, now(), now())
      transcribe(job_id, path)
      return json(res, 202, { job_id, sid, status: 'transcribing' })
    }

    const a = url.pathname.match(/^\/audio\/([0-9a-f-]{36})$/)
    if (req.method === 'GET' && a) {
      const path = join(AUDIO, `${a[1]}.wav`)
      if (!existsSync(path)) return json(res, 404, { error: 'audio expired or missing' })
      const body = readFileSync(path)
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': body.length })
      return res.end(body)
    }

    const j = url.pathname.match(/^\/voice\/jobs\/([\w-]+)$/)
    if (req.method === 'GET' && j) {
      const row = q.jobById.get(j[1])
      return row ? json(res, 200, row) : json(res, 404, { error: 'not found' })
    }

    if (req.method === 'POST' && url.pathname === '/messages') {
      const { sid, text, idempotency_key, job_id } = await readBody(req)
      if (job_id !== undefined) {
        // The target is fixed when recording starts. Picking another session later does not move it.
        const job = q.jobById.get(String(job_id))
        if (!job || job.status !== 'done') return json(res, 409, { error: 'voice job not done' })
        if (job.sid !== sid) return json(res, 409, { error: 'voice job belongs to another session' })
      }
      if (typeof sid !== 'string' || typeof text !== 'string' || typeof idempotency_key !== 'string') {
        return json(res, 400, { error: 'sid, text and idempotency_key are required' })
      }
      if (!text.trim() || text.length > TEXT_MAX) return json(res, 400, { error: `text must be 1 to ${TEXT_MAX} chars` })
      const prior = q.msgByKey.get(idempotency_key)
      if (prior) {
        if (prior.sid !== sid) return json(res, 409, { error: 'idempotency_key already used for another session' })
        return json(res, 200, prior)
      }
      const sock = live.get(sid)
      if (!sock) return json(res, 409, { error: 'session not live', sid })
      const message_id = randomUUID()
      q.insertMsg.run(message_id, sid, idempotency_key, text, now(), now())
      sock.write(JSON.stringify({ type: 'deliver', message_id, text }) + '\n')
      return json(res, 202, { message_id, sid, state: 'sending' })
    }

    const m = url.pathname.match(/^\/messages\/([\w-]+)$/)
    if (req.method === 'GET' && m) {
      const row = q.msgById.get(m[1])
      return row ? json(res, 200, row) : json(res, 404, { error: 'not found' })
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      let whisperOk = false
      try { whisperOk = (await fetch(WHISPER_URL, { signal: AbortSignal.timeout(1500) })).status < 500 } catch {}
      return json(res, 200, {
        uptime_s: Math.round((Date.now() - STARTED) / 1000),
        whisper: whisperOk ? 'ok' : 'down',
        tts: process.env.VOICE_REMOTE_TTS === 'off' ? 'off' : 'on',
        network: LAN ? network : 'off',
        live_sessions: live.size,
        open_questions: q.inbox.all().length,
        audio_kb: Math.round(sweepAudio() / 1024),
        latest_event: q.latestEvent.get().id ?? 0,
      })
    }

    if (req.method === 'GET' && url.pathname === '/questions') {
      return json(res, 200, { questions: q.inbox.all().map(x => ({ ...x, short: x.sid.slice(0, 4) })) })
    }

    const qa = url.pathname.match(/^\/questions\/([\w-]+)\/answers$/)
    if (req.method === 'POST' && qa) {
      const { text, idempotency_key, job_id } = await readBody(req)
      if (typeof text !== 'string' || typeof idempotency_key !== 'string') return json(res, 400, { error: 'text and idempotency_key are required' })
      if (!text.trim() || text.length > TEXT_MAX) return json(res, 400, { error: `text must be 1 to ${TEXT_MAX} chars` })
      const prior = q.msgByKeyQ.get(idempotency_key)
      if (prior) {
        if (prior.question_id !== qa[1]) return json(res, 409, { error: 'idempotency_key already used for something else' })
        return json(res, 200, prior)
      }
      const question = q.qById.get(qa[1])
      if (!question) return json(res, 404, { error: 'no such question' })
      if (job_id !== undefined) {
        const job = q.jobById.get(String(job_id))
        if (!job || job.status !== 'done') return json(res, 409, { error: 'voice job not done' })
        if (job.sid !== question.sid) return json(res, 409, { error: 'voice job belongs to another session' })
      }
      if (question.status === 'open' && question.expires_at < now()) closeQuestion(question.question_id, question.sid, 'expired')
      const sock = live.get(question.sid)
      if (!sock && question.status === 'open') closeQuestion(question.question_id, question.sid, 'cancelled')
      const current = q.qById.get(qa[1]).status
      if (current !== 'open') return json(res, 409, { error: `question ${current}`, status: current })
      const message_id = randomUUID()
      // The status check and the update are one statement, so two answers cannot both win.
      if (!q.answerQ.run(message_id, now(), question.question_id).changes) return json(res, 409, { error: 'question answered', status: 'answered' })
      q.insertMsgQ.run(message_id, question.sid, idempotency_key, text, now(), now(), question.question_id)
      event(question.sid, 'question_closed', question.question_id, 'answered')
      sock.write(JSON.stringify({ type: 'answer', question_id: question.question_id, message_id, text }) + '\n')
      return json(res, 202, { message_id, sid: question.sid, state: 'sending', question_id: question.question_id })
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const after = Number(url.searchParams.get('after') ?? 0) || 0
      // latest lets a device that just booted skip the backlog.
      return json(res, 200, { events: q.eventsAfter.all(after), latest: q.latestEvent.get().id ?? 0 })
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    if (!res.headersSent) json(res, e.status ?? 400, { error: e.message })
  }
}
const api = http.createServer(handler)
api.listen(PORT, HOST, () => process.stderr.write(`bridge on http://${HOST}:${PORT}, shims on ${SOCKET}\n`))

// --- TLS for the LAN listener ------------------------------------------------
// The device pins our own CA. The leaf is reissued at each start because the laptop's IP changes.
function tlsMaterial() {
  const dir = join(RUN, 'tls')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const f = n => join(dir, n)
  const ssl = (...a) => execFileSync('openssl', a, { stdio: ['ignore', 'ignore', 'pipe'] })
  if (!existsSync(f('ca.pem'))) {
    ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('ca.key'))
    ssl('req', '-x509', '-new', '-key', f('ca.key'), '-sha256', '-days', '3650', '-subj', '/CN=voice-remote local CA', '-out', f('ca.pem'))
  }
  const host = execFileSync('scutil', ['--get', 'LocalHostName']).toString().trim()
  const ips = (networkInterfaces()[LAN_IF] ?? []).filter(a => a.family === 'IPv4').map(a => a.address)
  if (!ips.length) throw new Error(`no IPv4 address on ${LAN_IF}, is Wi-Fi on?`)
  // mbedTLS on the ESP32 matches the host string against DNS names, so IPs go in as both kinds.
  const san = [`DNS:${host}.local`, 'DNS:localhost', ...ips.flatMap(ip => [`DNS:${ip}`, `IP:${ip}`])].join(',')
  writeFileSync(f('leaf.ext'), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`)
  ssl('ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', f('leaf.key'))
  ssl('req', '-new', '-key', f('leaf.key'), '-subj', `/CN=${host}.local`, '-out', f('leaf.csr'))
  ssl('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '30', '-sha256', '-extfile', f('leaf.ext'), '-out', f('leaf.pem'))
  chmodSync(f('ca.key'), 0o600); chmodSync(f('leaf.key'), 0o600)
  return { key: readFileSync(f('leaf.key')), cert: readFileSync(f('leaf.pem')), host, ip: ips[0] }
}

// The listener runs only on networks added with bin/provision.py, and follows the laptop to a new address.
const NETWORK_ID_CMD = process.env.VOICE_REMOTE_NETWORK_ID_CMD ?? join(ROOT, 'bin', 'network-id')
const TRUSTED = join(RUN, 'trusted-networks')
let lan = null, lanKey = '', network = 'none'
function trustedName(id) {
  if (!id || !existsSync(TRUSTED)) return null
  for (const line of readFileSync(TRUSTED, 'utf8').split('\n')) {
    const [mac, ...name] = line.trim().split(' ')
    if (mac === id) return name.join(' ') || mac
  }
  return null
}
function lanTick() {
  const ip = (networkInterfaces()[LAN_IF] ?? []).find(a => a.family === 'IPv4')?.address ?? ''
  let id = ''
  try { id = execFileSync(NETWORK_ID_CMD, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch {}
  const name = trustedName(id)
  const key = `${ip}|${name}`
  if (key === lanKey) return
  lanKey = key
  lan?.close()
  lan = null
  if (!ip) { network = 'none'; process.stderr.write('LAN off: no Wi-Fi address\n'); return }
  if (!name) { network = 'untrusted'; process.stderr.write(`LAN off: this network is not trusted (${id || 'unknown'}). Add it with bin/provision.py.\n`); return }
  network = name
  const t = tlsMaterial()
  lan = https.createServer({ key: t.key, cert: t.cert }, (req, res) => {
    const from = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
    if (ALLOW_IPS.length && !ALLOW_IPS.includes(from)) { req.socket.destroy(); return }
    handler(req, res)
  })
  lan.on('error', e => process.stderr.write(`LAN listener: ${e.message}\n`))
  lan.listen(LAN_PORT, t.ip, () => process.stderr.write(`LAN on https://${t.ip}:${LAN_PORT} (${t.host}.local), network ${name}${ALLOW_IPS.length ? ' allow ' + ALLOW_IPS.join(',') : ''}\n`))
}
if (LAN) { lanTick(); setInterval(lanTick, Number(process.env.VOICE_REMOTE_LAN_CHECK_MS ?? 10_000)).unref() }

let whisper = null
if (!process.env.VOICE_REMOTE_WHISPER_URL) {
  whisper = spawn('whisper-server', ['-m', MODEL, '--host', '127.0.0.1', '--port', String(WHISPER_PORT), '-l', 'auto'], { stdio: 'ignore' })
  whisper.on('error', e => process.stderr.write(`whisper-server failed to start: ${e.message}\n`))
}

const stop = () => { shimServer.close(); api.close(); lan?.close(); whisper?.kill(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
