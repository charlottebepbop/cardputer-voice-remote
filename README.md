# Cardputer voice remote for Claude Code

Talk to your Claude Code sessions from an M5 Cardputer. Hold Space, speak, read or hear the answer.

Unofficial project. Not affiliated with Anthropic.

It is a prototype built in a week. It works for one person on one laptop. It is not a product.

## How it works

```
Cardputer  --Wi-Fi, HTTPS-->  bridge (Node, on your Mac)  --channel-->  Claude Code session
  mic, screen, speaker          whisper.cpp, SQLite, TTS               one MCP shim per session
```

1. You pick a session on the device and record up to 30 seconds.
2. The bridge transcribes it with whisper.cpp. You read the text on the screen and confirm.
3. The text goes into that session as a Claude Code channel message.
4. Claude answers with the `remote_reply` tool. The bridge turns the reply into speech and the device plays it.
5. Claude can also ask you a question with `remote_ask_user` and wait for a spoken answer.

## What you need

- M5 Cardputer ADV and a USB cable
- macOS. The bridge uses `say`, `arp` and `route`.
- Node 22.5 or newer (the bridge uses `node:sqlite`)
- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) with `whisper-server` on your PATH, and a model in `models/` (default `ggml-small-q5_1.bin`)
- `openssl`, [PlatformIO](https://platformio.org), and [uv](https://docs.astral.sh/uv/) for the provisioning script
- Claude Code with Channels enabled. On a team or enterprise plan an org owner must turn it on. Channels are a research preview and custom ones need `--dangerously-load-development-channels`.

## Set up

```sh
npm install
npm test
```

Flash the firmware (this replaces whatever is on the device, so back it up first):

```sh
cd firmware && pio run -t upload
```

Start the bridge, then give the device its Wi-Fi, token and CA over USB:

```sh
bin/start-bridge
uv run --with pyserial python -I bin/provision.py
```

Start Claude Code through the launcher. Only sessions started this way receive messages:

```sh
cd ~/some/project && /path/to/voice-remote/bin/claude-remote
```

Pick the session on the device and speak.

## Layout

| Path | What it is |
| --- | --- |
| `bridge/` | HTTPS server, session routing, whisper and TTS jobs, SQLite |
| `claude-integration/` | MCP shim loaded by each Claude Code session |
| `firmware/` | Cardputer firmware (C++, PlatformIO) |
| `bin/` | Launcher, provisioning, token revocation, a typed stand-in for the device |
| `tests/` | 31 tests. They use fake sessions built from MCP clients, not Claude Code. |
| `docs/` | Build notes and live results for each milestone |

## Milestones

| Milestone | Result |
| --- | --- |
| 0. Typed message to a live session | Passed. [notes](docs/milestone-0.md) |
| 1. Record and play back on the device | Passed. No microSD needed, recordings use built-in flash |
| 2. Wi-Fi upload and transcription | Passed |
| 3. Spoken replies | Passed. [notes](docs/milestone-3-4.md) |
| 4. Claude asks questions | Passed. [notes](docs/milestone-3-4.md) |
| 5. Daily use: quiet mode, filter, status, token revocation | Passed. 31 of 31 messages answered, 0 sent to the wrong session. [notes](docs/milestone-5.md) |

Switching between home Wi-Fi and a phone hotspot is in [docs/networks.md](docs/networks.md).

## Known limits

- One speaker is assumed. There is no voice check.
- The first turn of a session is a warm-up message, because Claude Code lists MCP tools only after the first turn.
- Recordings stop at 30 seconds.
- Read [SECURITY.md](SECURITY.md) before you put this on a network.

## Licence

MIT
