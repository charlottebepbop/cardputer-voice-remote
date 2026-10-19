#!/usr/bin/env node
// Channel server for one Claude Code session. Claude Code spawns one copy per session,
// so the bridge connection closing is the signal that the session ended.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOCKET = process.env.VOICE_REMOTE_SOCKET ?? join(ROOT, 'run', 'bridge.sock')
const REPLY_MAX = 600
const ASK_MAX = 400
const WAIT_DEFAULT_S = 240
const WAIT_MAX_S = 600

const sid = randomUUID()
const cwd = process.cwd()
let branch = ''
try {
  branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
} catch {}

const log = (...a) => process.stderr.write(`[voice-remote ${sid.slice(0, 4)}] ${a.join(' ')}\n`)

const mcp = new Server(
  { name: 'voice-remote', version: '0.1.0' },
  {
    capabilities: { experimental: { 'claude/channel': {} }, tools: {} },
    instructions:
      'Messages from the user\'s handheld voice remote arrive as <channel source="voice-remote" message_id="...">. ' +
      'They are the user\'s dictated speech, transcribed, so expect small transcription errors. ' +
      'Handle them like a typed message from the user. Normal permission rules still apply. ' +
      'Every voice-remote message needs a remote_reply call, even a quick question answered from memory. ' +
      'The user is holding the device, not reading the terminal, so a terminal-only answer never reaches them. ' +
      'When done, call remote_reply once with the message_id and 1 to 3 short spoken sentences. ' +
      'The reply is read aloud: no code, file paths, URLs, secrets, or customer or personal data. ' +
      'Keep the full detail in the terminal. ' +
      'To ask the user something while they are away from the laptop, call remote_ask_user. ' +
      'It waits for their spoken answer. If it times out, a late answer arrives as a voice-remote message with a question_id.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'remote_reply',
    description: 'Send a short spoken reply to a message from the voice remote.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'string', description: 'message_id from the <channel> tag' },
        text: { type: 'string', description: '1 to 3 short sentences, plain speech' },
      },
      required: ['message_id', 'text'],
    },
  }, {
    name: 'remote_ask_user',
    description: 'Ask the user a question on their voice remote and wait for their spoken answer. ' +
      'Use it for a decision you need from the user. It is not a permission prompt: tool approvals still happen in the terminal.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, read aloud. Plain speech, max 400 chars. No secrets, customer or personal data.' },
        short_screen_text: { type: 'string', description: 'Up to 80 chars for the inbox list' },
        wait_seconds: { type: 'number', description: `How long to wait for a live answer. Default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}.` },
      },
      required: ['question'],
    },
  }],
}))

const waiting = new Map() // question_id -> resolve

async function askUser(args, signal) {
  const { question, short_screen_text, wait_seconds } = args
  if (typeof question !== 'string' || !question.trim()) return { isError: true, content: [{ type: 'text', text: 'question is required' }] }
  const question_id = randomUUID()
  const waitMs = Math.min(Math.max(Number(wait_seconds) || WAIT_DEFAULT_S, 5), WAIT_MAX_S) * 1000
  const answer = new Promise(resolve => waiting.set(question_id, resolve))
  if (!sendToBridge({ type: 'ask', question_id, text: question.slice(0, ASK_MAX), screen_text: String(short_screen_text ?? '').slice(0, 80) })) {
    waiting.delete(question_id)
    return { isError: true, content: [{ type: 'text', text: 'bridge not connected, question not asked' }] }
  }
  let timer
  const stopped = new Promise(resolve => {
    timer = setTimeout(() => resolve('timeout'), waitMs)
    signal?.addEventListener('abort', () => resolve('aborted'), { once: true })
  })
  const got = await Promise.race([answer, stopped])
  clearTimeout(timer)
  waiting.delete(question_id)
  if (typeof got === 'object') {
    return { content: [{ type: 'text', text: `The user answered by voice (message_id ${got.message_id}, question_id ${question_id}): ${got.text}` }] }
  }
  sendToBridge({ type: 'ask_stopped', question_id })
  return { content: [{ type: 'text', text:
    `No answer yet (question_id ${question_id}). The question stays in their inbox. ` +
    'A later answer arrives as a voice-remote message with this question_id. Do not ask the same question again.' }] }
}

mcp.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  if (req.params.name === 'remote_ask_user') return askUser(req.params.arguments ?? {}, extra?.signal)
  if (req.params.name !== 'remote_reply') throw new Error(`unknown tool: ${req.params.name}`)
  const { message_id, text } = req.params.arguments ?? {}
  if (typeof message_id !== 'string' || typeof text !== 'string' || !text.trim()) {
    return { isError: true, content: [{ type: 'text', text: 'message_id and text are required' }] }
  }
  if (!sendToBridge({ type: 'reply', message_id, text: text.slice(0, REPLY_MAX) })) {
    return { isError: true, content: [{ type: 'text', text: 'bridge not connected, reply not sent' }] }
  }
  return { content: [{ type: 'text', text: 'sent' }] }
})

let sock = null
let buf = ''

function sendToBridge(obj) {
  if (!sock || sock.destroyed) return false
  sock.write(JSON.stringify(obj) + '\n')
  return true
}

async function onBridgeMessage(msg) {
  if (msg.type === 'answer') return onAnswer(msg)
  if (msg.type !== 'deliver') return
  // Bridge restarts can resend a message it marked unknown. Never let that reach Claude twice.
  if (seen.has(msg.message_id)) {
    sendToBridge({ type: 'duplicate', message_id: msg.message_id })
    return
  }
  seen.add(msg.message_id)
  await mcp.notification({
    method: 'notifications/claude/channel',
    // Claude Code lists MCP tools and server instructions only after the first tool call.
    // A voice message as the first turn would never see remote_reply, so the tag names it.
    params: {
      content: msg.text,
      meta: {
        message_id: msg.message_id,
        reply_tool: 'mcp__voice-remote__remote_reply',
        reply_rule: 'Load the reply tool with ToolSearch if needed. Answer by calling it, or the user gets nothing.',
      },
    },
  })
  sendToBridge({ type: 'delivered', message_id: msg.message_id })
}
const seen = new Set()

async function onAnswer(msg) {
  if (seen.has(msg.message_id)) return sendToBridge({ type: 'duplicate', message_id: msg.message_id })
  seen.add(msg.message_id)
  const resolve = waiting.get(msg.question_id)
  if (resolve) {
    resolve({ text: msg.text, message_id: msg.message_id })
    return sendToBridge({ type: 'delivered', message_id: msg.message_id, mode: 'live' })
  }
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: msg.text,
      meta: {
        message_id: msg.message_id,
        question_id: msg.question_id,
        kind: 'late_answer',
        reply_tool: 'mcp__voice-remote__remote_reply',
        reply_rule: 'This answers your earlier remote_ask_user question with this question_id. Reply with the reply tool.',
      },
    },
  })
  sendToBridge({ type: 'delivered', message_id: msg.message_id, mode: 'late' })
}

function connect() {
  const s = net.createConnection(SOCKET)
  s.on('connect', () => {
    sock = s
    buf = ''
    sendToBridge({ type: 'hello', sid, label: basename(cwd), branch, cwd, pid: process.ppid })
    // After a bridge restart, tell it which questions still have a tool call waiting.
    sendToBridge({ type: 'ask_waiting', question_ids: [...waiting.keys()] })
    log('connected to bridge')
  })
  s.on('data', chunk => {
    buf += chunk
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i)
      buf = buf.slice(i + 1)
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      onBridgeMessage(msg).catch(e => log('deliver failed', e.message))
    }
  })
  s.on('error', () => {})
  s.on('close', () => {
    if (sock === s) sock = null
    setTimeout(connect, 2000)
  })
}

await mcp.connect(new StdioServerTransport())
connect()
// Claude Code closes stdin when the session ends.
process.stdin.on('end', () => process.exit(0))
