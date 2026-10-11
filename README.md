# mcp-server-esign-mock

A Model Context Protocol server that lets an AI agent drive a mock e-signature workflow, with a
**human approval gate** on anything that sends mail or cancels a document. In-memory backend, no
accounts or API keys, so you can learn MCP and agent safety without risk.

```
Agent (Claude Desktop, Cursor, ...) --MCP/stdio--> esign-mcp
  list_templates, create_envelope, get_status        (safe, no approval)
  send_envelope, cancel_envelope                     (human approval required)
```

## Tools

| Tool | Effect | Hints | Approval |
|---|---|---|---|
| `list_templates` | Read templates | read-only | No |
| `create_envelope` | Create a **draft** only | non-destructive | No |
| `get_status` | Envelope and per-signer status | read-only, idempotent | No |
| `send_envelope` | Email signers (mock) | destructive | **Yes** |
| `cancel_envelope` | Cancel draft or sent envelope | destructive | **Yes** |
| `simulate_signing` | Dev only, off by default (`ESIGN_DEV_TOOLS=1`) | | No |

## The approval gate (the interesting part)

1. **Elicitation (real gate).** If the client supports MCP elicitation, the server asks the human
   directly ("Send 'Project NDA' to ada@..., bo@...?"). The model never sees the answer channel and
   cannot approve for the person. Declines, cancels, crashes and `confirm: false` all fail closed.
2. **Code fallback (speed bump).** Clients without elicitation get a single-use, expiring code and
   an instruction to show the human. A misbehaving model can still call the tool twice, so this is
   only a speed bump.
3. **Deny mode.** Set `ESIGN_FALLBACK=deny` to block these actions entirely on clients that cannot
   ask the human. Use this whenever the action must be human-only.

More guardrails: drafts are the only thing an agent can create freely, sends are capped per session,
inputs are validated with zod (valid emails, 1 to 5 signers), and errors are returned as tool errors
instead of crashing the server.

## Run

```bash
npm ci
npm test                  # 18 tests using an in-memory MCP client and server
npm run build && node dist/server.js
```

Claude Desktop config (`claude_desktop_config.json`):

```json
{ "mcpServers": { "esign": { "command": "node", "args": ["/absolute/path/dist/server.js"],
  "env": { "ESIGN_FALLBACK": "deny" } } } }
```

Inspect it interactively: `npx @modelcontextprotocol/inspector node dist/server.js`.

## What you learn here

- Defining tools with schemas, annotations and structured errors
- Testing an MCP server end to end without a network, using linked in-memory transports
- Treating tool output as untrusted data and designing for a misbehaving model
- stdout is reserved for the protocol, so logs go to stderr

## Verified here

18 tests pass, and the built binary was started over stdio and answered `tools/list` and a tool call.
It has not been connected to Claude Desktop in this environment.

## Known limits

- State is in memory and lost on restart. Swap `EsignStore` for a real API client later.
- No authentication, since stdio servers run as the user. Add OAuth before exposing over HTTP.
- Mock only: no emails are sent and no documents are signed.

See `NOTES.md` for mistakes made and fixed.
