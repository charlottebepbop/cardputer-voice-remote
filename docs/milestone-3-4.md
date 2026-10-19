# Milestones 3 and 4

## Milestone 3: spoken replies (passed 15 Oct 2026)

Live run with two sessions (vr-test-a, vr-test-b). Routing correct, P plays, ESC stops, speech understandable.

| Measure | Value |
|---|---|
| Transcription, whisper-server small q5_1 | 0.6 s average, 1.3 s max (17 clips) |
| Delivery to reply, after the first-turn fix | 7.5 s average, 13.7 s max (5 messages) |
| Messages with a reply, whole day | 12 of 15. All 3 misses came before the first-turn fix |

Bugs found live:
- Claude Code lists MCP tools only after a session's first turn. A voice message as the first turn never saw `remote_reply`. `bin/claude-remote` now sends a warm-up turn.
- The device kept one last reply for all sessions, so B showed A's reply. It now keeps one per session.

## Milestone 4: Claude asks questions

`remote_ask_user(question, short_screen_text, wait_seconds)` waits up to 240 s (max 600) for a spoken answer.
After a timeout or a cancelled tool call, the question stays open. A later answer arrives as a channel message with `question_id` and `kind="late_answer"`.
Questions expire after 24 h (`VOICE_REMOTE_QUESTION_TTL_H`). Ending the session cancels them.

Automated (`tests/questions.test.mjs`, 7 tests): live answer, duplicate answer, answer recorded for another session,
late answer after timeout, late answer after cancel, bridge restart while a call waits, session end, expiry.

### Live test

1. Restart the bridge and both sessions (new shim code).
2. In vr-test-a type: `Use remote_ask_user to ask me which colour to use, then tell me what I said.`
3. The device beeps and shows `? 1`. Press I, Enter, P to hear it, hold Space to answer, Enter to send.
4. The terminal shows Claude got the answer in the same tool call.
5. Late answer: ask with `wait_seconds 10`, wait 15 s, then answer. It arrives as a new message and Claude replies by voice.
6. Answer the same question twice: the second try shows "Already answered. Not sent."
7. Ask in vr-test-b, then `/exit` it: the question leaves the inbox.

### Live result (15 Oct 2026): passed

- Live answer: "Which colour should I use?" answered in 51 s. It reached Claude in the same tool call (`delivered`, mode `live`).
- Late answer: "What should I name the file?" answered after the 10 s wait. It arrived as a `late_answer` message in the right session, in both A and B. In A, the Anthropic API then failed with "Server error mid-response", so that one got no voice reply. The remote's delivery was correct. B replied by voice.
- Answer twice: an answered question leaves the inbox, so the device cannot send a second answer. The bridge's 409 is covered by the automated test.
- Session end: `/exit` with an open question marked it `cancelled` the same second and removed it from the inbox.
