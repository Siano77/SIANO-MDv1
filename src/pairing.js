import * as B from '@whiskeysockets/baileys'
import pino from 'pino'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'

const makeWASocket = B.default?.default || B.default || B.makeWASocket
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' })

const MAX_ACTIVE = Number(process.env.MAX_ACTIVE) || 10
export const CODE_TTL = Number(process.env.CODE_TTL_SECONDS) || 150
const NUMBER_COOLDOWN_MS = 45_000
const SEND_TO_WHATSAPP = String(process.env.SEND_TO_WHATSAPP ?? 'true').toLowerCase() !== 'false'
const ACTIVE = new Set(['starting', 'waiting', 'linking'])

export class PairError extends Error {
  constructor(kind, message) {
    super(message)
    this.kind = kind
  }
}

const sessions = new Map()
const lastByNumber = new Map()
const jidNum = (j) => String(j ?? '').split('@')[0].split(':')[0]
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// Baileys pins a WhatsApp Web version at publish time and WhatsApp rejects old ones (405),
// so look up the live version and cache it for a few hours.
const versionCache = { v: null, at: 0 }
async function resolveVersion() {
  if (versionCache.v && Date.now() - versionCache.at < 6 * 3600_000) return versionCache.v
  for (const fn of [B.fetchLatestWaWebVersion, B.fetchLatestBaileysVersion]) {
    if (typeof fn !== 'function') continue
    try {
      const r = await fn()
      if (Array.isArray(r?.version) && r.version.length === 3) {
        versionCache.v = r.version
        versionCache.at = Date.now()
        return r.version
      }
    } catch { /* try the next source */ }
  }
  return undefined
}

export function stats() {
  const all = [...sessions.values()]
  return { active: all.filter((s) => ACTIVE.has(s.state)).length, total: all.length, max: MAX_ACTIVE }
}

export async function startPairing(number) {
  const now = Date.now()
  if ((lastByNumber.get(number) || 0) + NUMBER_COOLDOWN_MS > now) {
    throw new PairError('cooldown', 'A code was just requested for this number. Wait a minute, then try again.')
  }
  if (stats().active >= MAX_ACTIVE) throw new PairError('busy', 'The server is linking other numbers right now. Try again in a minute.')
  lastByNumber.set(number, now)

  const s = {
    id: crypto.randomBytes(16).toString('hex'),
    number,
    dir: path.join(os.tmpdir(), `siano-pair-${crypto.randomBytes(8).toString('hex')}`),
    state: 'starting',
    code: null,
    result: null,
    error: null,
    sock: null,
    closed: false,
    restarts: 0,
    retries: 0,
    createdAt: now,
    expiresAt: now + CODE_TTL * 1000,
    deliveredAt: 0,
  }
  sessions.set(s.id, s)
  await fs.mkdir(s.dir, { recursive: true })

  const codeReady = new Promise((resolve, reject) => {
    s.onCode = resolve
    s.onCodeError = reject
  })
  s.timer = setTimeout(() => end(s, 'expired'), CODE_TTL * 1000)
  open(s).catch((e) => fail(s, e))

  let guard
  try {
    await Promise.race([
      codeReady,
      new Promise((_, reject) => { guard = setTimeout(() => reject(new PairError('failed', 'WhatsApp took too long to answer. Try again.')), 30_000) }),
    ])
  } catch (e) {
    await end(s, 'failed', e.message)
    throw e instanceof PairError ? e : new PairError('failed', 'Could not get a pairing code from WhatsApp. Try again in a moment.')
  } finally {
    clearTimeout(guard)
  }
  return { id: s.id, code: s.code, expiresIn: CODE_TTL }
}

async function open(s) {
  if (s.closed) return
  const { state, saveCreds } = await B.useMultiFileAuthState(s.dir)
  s.saveCreds = saveCreds
  const version = await resolveVersion()
  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: { creds: state.creds, keys: B.makeCacheableSignalKeyStore(state.keys, logger) },
    logger,
    browser: B.Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
  })
  s.sock = sock
  sock.ev.on('creds.update', saveCreds)

  let requested = false
  const requestCode = async () => {
    if (requested || s.closed || s.code || state.creds.registered) return
    requested = true
    try {
      const raw = await sock.requestPairingCode(s.number)
      s.code = raw.match(/.{1,4}/g)?.join('-') || raw
      s.state = 'waiting'
      s.onCode(s.code)
    } catch (e) {
      requested = false
      if (++s.retries > 3) fail(s, e)
    }
  }
  setTimeout(requestCode, 3500)

  sock.ev.on('connection.update', async (u) => {
    if (s.closed || s.sock !== sock) return
    if (u.qr) requestCode()
    if (u.connection === 'open') {
      onLinked(s, sock).catch((e) => fail(s, e))
      return
    }
    if (u.connection === 'close') {
      const code = u.lastDisconnect?.error?.output?.statusCode
      if (s.state === 'linked') return
      if (code === 515) {
        // Expected right after WhatsApp accepts the code: reconnect with the saved credentials.
        s.state = 'linking'
        if (++s.restarts > 3) return fail(s, new Error('Linking did not finish. Start over.'))
        await saveCreds().catch(() => {})
        return open(s).catch((e) => fail(s, e))
      }
      if (!s.code && (code === 405 || code === 428 || code === 408) && ++s.retries <= 3) {
        if (code === 405) versionCache.v = null // stale WhatsApp version: look it up again
        try { sock.end(undefined) } catch { /* already closed */ }
        await wait(1200)
        return open(s).catch((e) => fail(s, e))
      }
      fail(s, new Error(code === 405 ? 'WhatsApp rejected the connection. Try again in a few minutes.' : 'The connection to WhatsApp dropped. Start over.'))
    }
  })
}

async function onLinked(s, sock) {
  if (s.state === 'linked' || s.closed) return
  await s.saveCreds()
  const text = await fs.readFile(path.join(s.dir, 'creds.json'), 'utf8')
  const creds = JSON.parse(text)
  if (!creds.registered) throw new Error('Linking did not finish. Start over.')
  const me = creds.me || {}
  const number = jidNum(me.id || sock.user?.id)
  const lid = jidNum(me.lid || sock.user?.lid)
  const sessionId = `SIANO~${zlib.gzipSync(Buffer.from(text)).toString('base64')}`

  s.result = { sessionId, number, lid }
  s.state = 'linked'
  clearTimeout(s.timer)

  if (SEND_TO_WHATSAPP) {
    // Also drop the details into the user's own "Message yourself" chat, handy on a phone.
    try {
      const to = B.jidNormalizedUser(sock.user.id)
      await sock.sendMessage(to, { text: '*SIANO v1 is linked ✅*\nYour SESSION_ID is in the next message. Paste it into your hosting panel.\nKeep it private: anyone who has it can control this WhatsApp.' })
      await sock.sendMessage(to, { text: sessionId })
      await sock.sendMessage(to, { text: `OWNER_NUMBER=${number}${lid ? `\nOWNER_LID=${lid}` : ''}` })
      await wait(2500)
    } catch { /* the website already has the details */ }
  }
  await teardown(s)
}

async function teardown(s) {
  s.closed = true
  clearTimeout(s.timer)
  try { s.sock?.end(undefined) } catch { /* already closed */ }
  await fs.rm(s.dir, { recursive: true, force: true }).catch(() => {})
}

async function end(s, state, error) {
  if (s.state === 'linked') return
  s.state = state
  s.error = error || null
  await teardown(s)
}

function fail(s, e) {
  s.onCodeError?.(e)
  return end(s, 'failed', e?.message || 'Something went wrong. Start over.')
}

export function getPairing(id) {
  const s = sessions.get(id)
  if (!s) return { state: 'expired' }
  if (s.state === 'linked') {
    s.deliveredAt ||= Date.now()
    return { state: 'linked', ...s.result }
  }
  const out = { state: s.state }
  if (s.state === 'waiting') out.expiresIn = Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000))
  if (s.state === 'failed') out.error = s.error
  return out
}

// Housekeeping: forget finished sessions quickly, and never keep anything for long.
const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    const age = now - s.createdAt
    const done =
      (s.state === 'linked' && s.deliveredAt && now - s.deliveredAt > 90_000) ||
      ((s.state === 'failed' || s.state === 'expired') && age > CODE_TTL * 1000 + 60_000) ||
      age > 15 * 60_000
    if (done) {
      if (!s.closed) teardown(s)
      sessions.delete(id)
    }
  }
  for (const [n, t] of lastByNumber) if (now - t > NUMBER_COOLDOWN_MS * 4) lastByNumber.delete(n)
}, 30_000)
sweeper.unref()

export async function shutdown() {
  await Promise.all([...sessions.values()].map((s) => (s.closed ? null : teardown(s))))
}
