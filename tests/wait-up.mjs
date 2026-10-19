import net from 'node:net'

// A fixed sleep after spawn is too short on slower Node builds. Poll until the port accepts a connection.
export async function waitUp(port, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await new Promise(r => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => { s.destroy(); r(true) })
      s.on('error', () => r(false))
    })
    if (ok) return
    await new Promise(r => setTimeout(r, 50))
  }
  throw new Error(`bridge did not listen on ${port} within ${ms} ms`)
}
