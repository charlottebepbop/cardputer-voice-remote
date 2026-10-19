# Milestone 0: typed round trip into a live session

Automated: `node --test tests/routing.test.mjs` (9 tests: routing, idempotency, reply ownership, stale session, bridge crash, auth, size). It uses fake sessions built from MCP clients, not Claude Code.

Live test, needs a human for the dev-channel dialog:

1. Terminal 1: `node bridge/bridge.mjs`
2. Terminals 2 and 3: `cd` into two different throwaway folders and run `bin/claude-remote`. Pick "I am using this for local development".
3. Terminal 4: `bin/remote.mjs list`, then `bin/remote.mjs send <id> "What folder are you in? Reply in one sentence."`
4. Pass: only the targeted session shows `← voice-remote: ...`, and Terminal 4 prints `Reply: ...`.
5. Quit one session (`/exit`), then send to its id again. Pass: `Rejected (409)`.
6. In a session, start a long task, then send a message while it is busy. Pass: it is handled on the next turn.
7. Trigger a permission prompt in a session, then send a message. Pass: the prompt stays, the message waits.

Known gaps: "delivered" means written to the session's channel, not read by Claude. Only a reply proves Claude saw it. No busy or idle state yet.

## Live result, 15 Oct 2026

- Step 4 and 5 passed: two real sessions listed, message reached session A only, spoken-style reply came back.
- Step 7 passed: a message sent while session A was busy was handled after the current task, and replied to.
- Step 6 (ended session) not reported live. Covered by the automated stale-session test.
- Permission-prompt case not run live.
