# Security

This project types text into a live Claude Code session. Read this before you run it.

## What the risk is

A message that reaches the bridge becomes a message to Claude, inside whatever session you picked.
That session may have connectors (Slack, Gmail, a CRM) and shell access. Anyone who can send a message can try prompt injection through it.
Permission prompts stay in the terminal, but do not rely on them as the only guard.

## What the bridge does

- Listens on `127.0.0.1` by default. The Wi-Fi listener is off unless `VOICE_REMOTE_LAN=1`.
- With the Wi-Fi listener on, it binds to one interface (`en0`), not `0.0.0.0`. Other interfaces such as a VPN do not see it.
- It only listens on networks you added with `bin/provision.py`. A network is named by its gateway MAC. Never add office or event Wi-Fi.
- HTTPS with a local CA made on first start. The device pins that CA.
- Every request needs the device token. Optional `VOICE_REMOTE_ALLOW_IPS` drops other addresses before the token check.
- Audio is deleted after transcription. Database rows older than 7 days are deleted.

## If the device is lost

1. Run `bin/revoke-token`. The bridge rejects the old token at once.
2. Delete `run/tls` and restart the bridge to replace the CA.

## What it does not do

- It does not check who is speaking. Anyone holding the device can send.
- "Delivered" means written to the session channel. It does not mean Claude acted on it.
- It is a prototype. Do not use it with data you could not paste into that session by hand.

## Reporting a problem

Open a private security advisory on the repository. Do not post tokens or logs in a public issue.
