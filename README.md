# SIANO pair site

https://siano-mdv1-pairing-code.onrender.com/

A small website that links a WhatsApp number using a pairing code and hands back a `SESSION_ID` (plus `OWNER_NUMBER` / `OWNER_LID`) ready to paste into a bot host's environment variables.

## How it works

1. Visitor enters their WhatsApp number.
2. The server opens a temporary Baileys connection and requests a pairing code (`sock.requestPairingCode`) — no QR code needed.
3. Visitor enters the code in WhatsApp (Settings → Linked devices → Link a device → Link with phone number instead).
4. Once WhatsApp confirms the link, the server reads the resulting `creds.json`, compresses and base64-encodes it into a single `SESSION_ID` string, deletes the temporary session files from disk, and shows the result on the page.

Nothing is written to a database — sessions live in memory only for the few minutes it takes to link, then the credential files are deleted (`fs.rm`) right after the `SESSION_ID` is handed back.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

## Deploy (Render / Vercel / Replit)

- **Render / Replit**: these run a persistent Node process, which this needs (it keeps an in-memory WhatsApp connection open while a code is pending). Set the start command to `npm install && npm start`, and set `PORT` if the platform requires a specific one (Render sets it automatically).
- **Vercel**: works for the static frontend, but its serverless functions are short-lived and stateless, which doesn't suit a held-open WhatsApp socket. Use Render or Replit (or any host that runs a normal long-lived Node server) for this piece instead.

No environment variables are required to run it. Optional ones:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `MAX_ACTIVE` | `10` | Cap on pairing attempts in progress at once |
| `CODE_TTL_SECONDS` | `150` | How long a pairing code stays valid |
| `SEND_TO_WHATSAPP` | `true` | Also DM the session details to the user's own WhatsApp once linked |

## Security notes

- Serve this over **HTTPS only** in production (Render/Replit/Vercel all do this by default) — the page transmits a full session credential.
- The generated `SESSION_ID` is equivalent to a password for that WhatsApp number. The site never stores it after handing it to the visitor, but whoever runs this server could technically log it — so only deploy a copy you trust, and say so if you ever host this for other people.
- A per-IP rate limit and a per-number cooldown are built in to keep one visitor from hammering WhatsApp's pairing endpoint.
