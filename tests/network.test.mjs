// The LAN listener runs only on trusted networks and follows network changes without a restart.
// Run: node --test tests/network.test.mjs
import { test, after } from 'node:test'
import { waitUp } from './wait-up.mjs'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const RUN = mkdtempSync(join(tmpdir(), 'vr-n-'))
const PORT = 22790 + Math.floor(Math.random() * 500)
const LAN_PORT = PORT + 500
// A fake gateway MAC stands in for bin/network-id.
const idFile = join(RUN, 'id')
const idCmd = join(RUN, 'network-id')
writeFileSync(idCmd, `#!/bin/sh\ncat "${idFile}"\n`)
chmodSync(idCmd, 0o755)
writeFileSync(idFile, 'aa:bb:cc:dd:ee:01\n')

const bridge = spawn('node', [join(ROOT, 'bridge', 'bridge.mjs')], {
  env: {
    ...process.env, VOICE_REMOTE_RUN: RUN, VOICE_REMOTE_SOCKET: join(RUN, 'b.sock'), VOICE_REMOTE_PORT: String(PORT),
    VOICE_REMOTE_WHISPER_URL: 'http://127.0.0.1:9', VOICE_REMOTE_TTS: 'off',
    VOICE_REMOTE_LAN: '1', VOICE_REMOTE_LAN_IF: 'lo0', VOICE_REMOTE_LAN_PORT: String(LAN_PORT),
    VOICE_REMOTE_NETWORK_ID_CMD: idCmd, VOICE_REMOTE_LAN_CHECK_MS: '200',
  },
  stdio: ['ignore', 'ignore', 'pipe'],
})
let log = ''
bridge.stderr.on('data', d => { log += d })
after(() => bridge.kill())

const listening = () => new Promise(r => {
  const s = net.connect(LAN_PORT, '127.0.0.1')
  s.on('connect', () => { s.destroy(); r(true) })
  s.on('error', () => r(false))
})
const status = async () => {
  const token = (await import('node:fs')).readFileSync(join(RUN, 'device-token'), 'utf8').trim()
  return (await (await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { Authorization: `Bearer ${token}` } })).json()).network
}

// Polls until fn() returns want. Cert issuing and the network check take longer on slow runners.
async function until(fn, want, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn() === want) return
    await sleep(100)
  }
}

test('untrusted network: no listener', async () => {
  await waitUp(PORT)
  await sleep(800)
  assert.equal(await listening(), false)
  assert.equal(await status(), 'untrusted')
})

test('trusting the network starts the listener, moving away stops it', async () => {
  writeFileSync(join(RUN, 'trusted-networks'), 'aa:bb:cc:dd:ee:01 Home\n')
  await until(listening, true) // includes issuing the cert
  assert.equal(await listening(), true, `bridge stderr:\n${log}`)
  assert.equal(await status(), 'Home')
  writeFileSync(idFile, 'aa:bb:cc:dd:ee:99\n')
  await until(listening, false)
  assert.equal(await listening(), false)
  assert.equal(await status(), 'untrusted')
})
