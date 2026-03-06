# myagent — Claude Code Instructions

## Project layout

```
myagent/                  Node.js agent package (pi-mono based)
  src/index.ts            Agent entry point — spawns MCP server, runs agent loop
  src/logs.ts             Session log explorer CLI
  package.json
mcp/browser/
  server.py               FastMCP Python browser server (Playwright)
  pyproject.toml          Python deps — pin playwright==1.58.0
.env                      ANTHROPIC_API_KEY (gitignored)
.myagent/                 Session logs — <uuid>.jsonl per run (gitignored)
```

## Running

```bash
# Start agent (fetches HN top 5 by default)
cd myagent && npm run dev

# Browse session logs
npm run logs              # list all sessions
npm run logs last         # most recent session
npm run logs <index>      # by index (0 = newest)
npm run logs <uuid>       # by full or partial UUID
```

## Key architecture

- **Agent loop**: `@mariozechner/pi-agent-core` `agentLoop()` — yields `AgentEvent` stream
- **AI model**: `@mariozechner/pi-ai` `getModel("anthropic", "claude-sonnet-4-5")`
- **Browser MCP server**: spawned via `StdioClientTransport` pointing at `mcp/browser/server.py`
- **MCP tools** wrapped as `AgentTool` using `Type.Unsafe()` to pass JSON Schema through unchanged
- **`convertToLlm`** strips images and truncates text >8000 chars to avoid 200k token overflow
- **Session logging**: JSONL to `.myagent/<uuid>.jsonl` — one JSON line per agent event

## Python MCP server notes

- Uses `playwright.chromium.launch(headless=False)` by default (Playwright's bundled Chromium)
- CDP opt-in via `BROWSER_CDP_URL` env var
- Accessibility tree via `page.locator("body").aria_snapshot()` — NOT `page.accessibility.snapshot()` (removed in Playwright 1.58)
- Semantic locator routing in `_make_locator()`: `role=`, `label=`, `placeholder=`, `text=`, `css=`, fallback to partial text

## Common pitfalls

- `page.accessibility.snapshot()` is removed in Playwright 1.58 — use `page.locator("body").aria_snapshot()`
- HN ARIA tree alone can exceed 200k tokens — always apply `convertToLlm` truncation
- MCP server path from `myagent/src/index.ts` is `../../mcp/browser/server.py` (two levels up)
- `dotenv` loaded at top of `index.ts` via `new URL("../../.env", import.meta.url).pathname`
- API errors surface as `message_end` with `stopReason === "error"` — check `msg.errorMessage`

## Git

- `node_modules/`, `dist/`, `.env`, `.myagent/` are all gitignored
- Never commit node_modules — GitHub push protection will block it (Google OAuth secrets in pi-ai/dist)
