#!/usr/bin/env node
// Typed stand-in for the Cardputer. Usage:
//   bin/remote.mjs list
//   bin/remote.mjs send <short-id> "text"
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const token = readFileSync(join(ROOT, 'run', 'device-token'), 'utf8').trim()
const base = `http://127.0.0.1:${process.env.VOICE_REMOTE_PORT ?? 8790}`
const api = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const [cmd, short, ...rest] = process.argv.slice(2)

const { sessions } = (await api('GET', '/sessions')).body
if (cmd === 'list' || !cmd) {
  if (!sessions.length) console.log('No live sessions. Start one with bin/claude-remote.')
  for (const s of sessions) console.log(`${s.short}  ${s.label}${s.branch ? ' (' + s.branch + ')' : ''}  ${s.cwd}`)
  process.exit(0)
}
if (cmd !== 'send' || !short || !rest.length) { console.error('usage: send <short-id> "text"'); process.exit(2) }
const matches = sessions.filter(s => s.short === short)
if (matches.length !== 1) { console.error(matches.length ? 'Short id is ambiguous.' : 'No live session with that id.'); process.exit(1) }
const target = matches[0]
const cursor = Math.max(0, ...(await api('GET', '/events?after=0')).body.events.map(e => e.event_id))
const r = await api('POST', '/messages', { sid: target.sid, text: rest.join(' '), idempotency_key: randomUUID() })
if (r.status !== 202) { console.error(`Rejected (${r.status}): ${r.body.error}`); process.exit(1) }
console.log(`Sent to ${target.label} ${target.short}. Waiting for a reply (Ctrl-C to stop waiting; Claude keeps working).`)
let after = cursor, state = 'sending'
for (;;) {
  const m = (await api('GET', `/messages/${r.body.message_id}`)).body
  if (m.state !== state) { state = m.state; console.log(`Status: ${state}`) }
  if (state === 'unknown') { console.log('Delivery uncertain. Check the session.'); process.exit(1) }
  for (const e of (await api('GET', `/events?after=${after}`)).body.events) {
    after = e.event_id
    if (e.type === 'reply' && e.message_id === r.body.message_id) { console.log(`Reply: ${e.text}`); process.exit(0) }
    if (e.type === 'session_ended' && e.sid === target.sid) { console.log('Session ended before replying.'); process.exit(1) }
  }
  await sleep(2000)
}
