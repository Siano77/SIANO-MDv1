const $ = (id) => document.getElementById(id)
const steps = { number: $('step-number'), code: $('step-code'), done: $('step-done'), error: $('step-error') }
function show(name) {
  for (const [k, el] of Object.entries(steps)) el.hidden = k !== name
}

let pollTimer = null
let countdownTimer = null

function stopPolling() {
  clearInterval(pollTimer)
  clearInterval(countdownTimer)
  pollTimer = null
  countdownTimer = null
}

function startCountdown(seconds) {
  let left = seconds
  const bar = $('timer-bar')
  const text = $('timer-text')
  const total = seconds
  const tick = () => {
    const pct = Math.max(0, (left / total) * 100)
    bar.style.width = pct + '%'
    if (pct < 25) bar.style.background = 'var(--danger)'
    else if (pct < 50) bar.style.background = 'var(--warn)'
    const m = Math.floor(left / 60)
    const s = String(Math.max(0, left) % 60).padStart(2, '0')
    text.textContent = left > 0 ? `expires in ${m}:${s}` : 'expired'
    left--
  }
  tick()
  clearInterval(countdownTimer)
  countdownTimer = setInterval(tick, 1000)
}

async function requestCode(number) {
  const btn = $('btn-request')
  const err = $('err-number')
  err.hidden = true
  btn.disabled = true
  btn.textContent = 'Requesting…'
  try {
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ number }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Could not get a code. Try again.')
    $('code-text').textContent = data.code
    $('status-text').textContent = 'Waiting for WhatsApp…'
    show('code')
    startCountdown(data.expiresIn)
    poll(data.id)
  } catch (e) {
    err.textContent = e.message
    err.hidden = false
  } finally {
    btn.disabled = false
    btn.textContent = 'Get pairing code'
  }
}

function poll(id) {
  stopPolling()
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/pair/${id}`)
      const data = await res.json()
      if (data.state === 'linked') return onLinked(data)
      if (data.state === 'failed') return onError(data.error || 'Linking failed. Please try again.')
      if (data.state === 'expired') return onError('The code expired before it was used. Request a new one.')
      if (data.state === 'linking') $('status-text').textContent = 'Code accepted — finishing up…'
    } catch { /* transient network hiccup, keep polling */ }
  }, 2500)
}

function onLinked(data) {
  stopPolling()
  $('out-session').textContent = data.sessionId
  $('out-number').textContent = data.number
  $('out-lid').textContent = data.lid || '(not provided by WhatsApp for this account)'
  $('out-block').textContent = `SESSION_ID=${data.sessionId}\nOWNER_NUMBER=${data.number}${data.lid ? `\nOWNER_LID=${data.lid}` : ''}`
  show('done')
}

function onError(message) {
  stopPolling()
  $('err-text').textContent = message
  show('error')
}

$('form-number').addEventListener('submit', (e) => {
  e.preventDefault()
  const number = $('number').value.replace(/\D/g, '')
  if (number.length < 7 || number.length > 15) {
    $('err-number').textContent = 'Enter a valid number with country code, digits only.'
    $('err-number').hidden = false
    return
  }
  requestCode(number)
})
$('number').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '') })

function reset() {
  stopPolling()
  $('form-number').reset()
  show('number')
}
$('btn-again').addEventListener('click', reset)
$('btn-retry').addEventListener('click', reset)

function flashCopied(btn) {
  const original = btn.textContent
  btn.textContent = 'Copied'
  btn.classList.add('copied')
  setTimeout(() => { btn.textContent = original; btn.classList.remove('copied') }, 1500)
}
async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    document.body.removeChild(ta)
  }
  flashCopied(btn)
}

$('btn-copy-code').addEventListener('click', (e) => copyText($('code-text').textContent.replace(/\s/g, ''), e.currentTarget))
document.querySelectorAll('.copy[data-copy]').forEach((btn) => {
  btn.addEventListener('click', () => copyText($(btn.dataset.copy).textContent, btn))
})
