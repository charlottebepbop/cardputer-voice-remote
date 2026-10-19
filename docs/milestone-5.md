# Milestone 5: daily use

| Feature | How |
|---|---|
| Quiet mode | D on the picker or Ready screen. No beeps; the `? N` badge and inbox still update. Kept across restarts. Header shows `q`. |
| Session filter | `/` on the picker, type part of a name, Enter. `` ` `` clears it. |
| Status screen | S on the picker or Ready screen: Wi-Fi, bridge, last call time, whisper, heap, flash. R refreshes. |
| Backoff | When the bridge does not answer, polling slows to 6, 12, then 30 s, and the header shows `no bridge`. |
| Token revocation | `bin/revoke-token`. The bridge rejects the old token at once. Then `bin/provision.py --token-only` over USB, no Wi-Fi password needed. |
| Vocabulary hints | One word per line in `run/vocab.txt`, read on every transcription. |
| Clean-up | Rows older than 7 days are deleted at start and hourly (`VOICE_REMOTE_RETENTION_DAYS`). Bridge audio is capped at 50 MB. |

Automated: `tests/daily.test.mjs` (4 tests). Full suite: 29 tests.

## Acceptance run

30 voice round trips across two sessions, mixed: plain questions, one question from Claude, quiet mode on for some.
Pass: at least 27 replies, zero wrong-session deliveries, no device failure that needs a cable.
Counted from `run/bridge.db` afterwards. This is a prototype test, not evidence of production reliability.

### Result (15 Oct 2026): passed

31 messages, 15:46 to 18:03 UTC. vr-test-a 20, vr-test-b 11. 6 were spoken answers to Claude's questions.

| Measure | Value |
|---|---|
| Messages with a response | 31 of 31. 27 got a `remote_reply`, 4 got a follow-up `remote_ask_user` |
| Wrong-session deliveries | 0. Each message `sid` matches its `voice_jobs.sid` |
| Device failures needing a cable | 0 |

The sessions stayed open through a 1.5 h pause (16:00 to 17:27) and carried on.

Feedback from the run, fixed the same evening:
- Recordings stopped at 15 s. The plan set 15 s "initially". Now 30 s, one whisper window. The device shortens it if flash is low.
- The first sound of every reply was cut off. The amp needs about 200 ms after `Speaker.begin()`, so playback now starts with 256 ms of silence.
