import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startPairing, getPairing, stats, PairError, shutdown } from './src/pairing.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT) || 3000
const app = express()

app.disable('x-powered-by')
app.use(express.json({ limit: '4kb' }))
app.use((req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('x-frame-options', 'DENY')
  next()
})

// Simple sliding-window limiter: a handful of pairing requests per IP per minute.
const hits = new Map()
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs)
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests. Wait a bit and try again.' })
    arr.push(now)
    hits.set(ip, arr)
    next()
  }
}
setInterval(() => hits.clear(), 10 * 60_000).unref()

const DIGITS = /^\d{7,15}$/

app.post('/api/pair', rateLimit(6, 60_000), async (req, res) => {
  const number = String(req.body?.number || '').replace(/\D/g, '')
  if (!DIGITS.test(number)) {
    return res.status(400).json({ error: 'Enter your WhatsApp number with country code, digits only (e.g. 2348012345678).' })
  }
  try {
    const r = await startPairing(number)
    res.json(r)
  } catch (e) {
    const known = e instanceof PairError
    res.status(known ? 409 : 500).json({ error: known ? e.message : 'Could not start pairing. Try again shortly.' })
  }
})

app.get('/api/pair/:id', rateLimit(60, 60_000), (req, res) => {
  res.json(getPairing(req.params.id))
})

app.get('/api/stats', (req, res) => res.json(stats()))

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }))
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')))

const server = app.listen(PORT, () => console.log(`SIANO pair site listening on :${PORT}`))

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\nshutting down…')
    await shutdown()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
