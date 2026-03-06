import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { agentLoop } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

// ---------------------------------------------------------------------------
// MCP browser client — spawns mcp/browser/server.py and wraps its tools
// ---------------------------------------------------------------------------

async function createBrowserTools() {
	const serverPath = new URL("../../mcp/browser/server.py", import.meta.url).pathname;

	const transport = new StdioClientTransport({
		command: "python3",
		args: [serverPath],
	});

	const client = new Client({ name: "myagent", version: "1.0.0" });
	await client.connect(transport);

	const { tools: mcpTools } = await client.listTools();

	const agentTools = mcpTools.map((tool) => ({
		name: tool.name,
		label: tool.name,
		description: tool.description ?? "",
		// Use Type.Unsafe to pass the MCP JSON Schema through to the LLM unchanged
		parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as any),
		execute: async (_toolCallId: string, params: Record<string, unknown>) => {
			const result = await client.callTool({ name: tool.name, arguments: params });
			const content = (result.content as any[]).map((c) => {
				if (c.type === "image") {
					return { type: "image" as const, data: c.data as string, mimeType: c.mimeType as string };
				}
				return { type: "text" as const, text: typeof c.text === "string" ? c.text : JSON.stringify(c) };
			});
			return { content, details: {} };
		},
	}));

	return { client, agentTools };
}

// ---------------------------------------------------------------------------
// Session logger — writes one JSON line per event to .myagent/<uuid>.jsonl
// ---------------------------------------------------------------------------

function createSessionLogger(sessionId: string) {
	const dir = join(process.cwd(), ".myagent");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${sessionId}.jsonl`);

	function log(record: object) {
		appendFileSync(file, JSON.stringify({ ts: Date.now(), ...record }) + "\n");
	}

	return { file, log };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const apiKey = getEnvApiKey("anthropic");
if (!apiKey) {
	console.error("Missing ANTHROPIC_API_KEY environment variable.");
	process.exit(1);
}

const model = getModel("anthropic", "claude-sonnet-4-5");
const sessionId = randomUUID();
const { file: sessionFile, log } = createSessionLogger(sessionId);

// ---------------------------------------------------------------------------
// Resolve prompt from CLI arg, file, or stdin
// ---------------------------------------------------------------------------

async function resolvePrompt(): Promise<string> {
	const arg = process.argv[2];

	if (arg) {
		// If it looks like a file path and exists, read it
		if (existsSync(arg)) {
			return readFileSync(arg, "utf8").trim();
		}
		// Otherwise treat the argument itself as the prompt
		return arg;
	}

	// No arg — read from stdin (supports pipe or interactive input)
	if (!process.stdin.isTTY) {
		const chunks: string[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk);
		return chunks.join("").trim();
	}

	// Interactive: prompt the user
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question("Prompt: ", (answer) => {
			rl.close();
			resolve(answer.trim());
		});
	});
}

const promptText = await resolvePrompt();
if (!promptText) {
	console.error("No prompt provided.");
	process.exit(1);
}

console.log("Starting agent...\n");
console.log(`Session log: ${sessionFile}\n`);

const { client: mcpClient, agentTools } = await createBrowserTools();

const prompt = [
	{
		role: "user" as const,
		content: promptText,
		timestamp: Date.now(),
	},
];

log({ type: "session_start", sessionId, model: model.id, prompt });

const searchTool = {
	name: "search",
	label: "search",
	description:
		"Search the web using Brave Search API. Returns titles, URLs, and descriptions. " +
		"Use this instead of navigating to google.com — faster and avoids CAPTCHAs.",
	parameters: Type.Object({
		query: Type.String({ description: "Search query" }),
		count: Type.Optional(Type.Number({ description: "Number of results (default 10, max 20)" })),
	}),
	execute: async (_toolCallId: string, params: { query: string; count?: number }) => {
		const apiKey = process.env.BRAVE_API_KEY ?? "";
		if (!apiKey) return { content: [{ type: "text" as const, text: "Error: BRAVE_API_KEY not set" }], details: {} };
		const count = Math.min(params.count ?? 10, 20);
		const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(params.query)}&count=${count}`;
		try {
			const resp = await fetch(url, {
				headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
			});
			const data = await resp.json() as any;
			const results = (data?.web?.results ?? []) as any[];
			const text = results.map((r: any, i: number) =>
				`${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description ?? ""}`
			).join("\n\n") || "No results found";
			return { content: [{ type: "text" as const, text }], details: {} };
		} catch (e) {
			return { content: [{ type: "text" as const, text: `Error: ${e}` }], details: {} };
		}
	},
};

const context = {
	systemPrompt: `You are a browser automation agent. Use the browser tools to navigate and extract information from web pages.

Tool usage guidelines:
- search(): Always prefer this over navigating to Google/Bing. It returns structured results instantly.
- navigate(), go_back(), go_forward(), new_tab(): These already return the page title and top headings. Only call observe() afterwards if you need the full interactive element tree to click something or the heading summary is insufficient.
- observe(): Use selector= to scope the ARIA tree when you only care about a specific section (e.g. selector="main", selector="article"). Avoid full-page observe on content-heavy sites.
- Cookie/consent dialogs are dismissed automatically after navigation — do not try to click them yourself unless observe() shows one is still present.`,
	messages: [] as any[],
	tools: [...agentTools, searchTool],
};

const config = {
	model,
	apiKey,
	// Sanitise tool results before sending to the LLM:
	//   - drop image content (base64 screenshots blow up the context window)
	//   - truncate long text to 8 000 characters
	convertToLlm: (messages: any[]) =>
		messages.map((msg) => {
			if (msg.role !== "toolResult") return msg;
			return {
				...msg,
				content: (msg.content as any[])
					.filter((c: any) => c.type !== "image")
					.map((c: any) =>
						c.type === "text" && c.text.length > 8000
							? { ...c, text: c.text.slice(0, 8000) + "\n…[truncated]" }
							: c,
					),
			};
		}),
};

function ts() {
	return `[${new Date().toLocaleTimeString()}]`;
}

let toolCallCount = 0;
const stream = agentLoop(prompt, context, config);

try {
	for await (const event of stream) {
		log(event);

		switch (event.type) {
			case "agent_start":
				console.log(`${ts()} Agent started`);
				break;

			case "turn_start":
				console.log(`\n${ts()} ── Turn ──`);
				break;

			case "tool_execution_start":
				toolCallCount++;
				console.log(`${ts()} → ${event.toolName}(${JSON.stringify(event.args)})`);
				break;

			case "tool_execution_end": {
				const text = (event.result.content as any[])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("");
				const tag = event.isError ? "ERROR" : "OK";
				const preview = text ? ": " + (text.length > 120 ? text.slice(0, 120) + "…" : text) : "";
				if (event.isError) {
					console.error(`${ts()} ← ${event.toolName} [${tag}]${preview}`);
				} else {
					console.log(`${ts()} ← ${event.toolName} [${tag}]${preview}`);
				}
				break;
			}

			case "message_end": {
				const msg = event.message as any;
				if (msg.role === "assistant") {
					if (msg.stopReason === "error") {
						const errMsg = msg.errorMessage ?? "unknown error";
						console.error(`${ts()} ⚠ API error: ${errMsg}`);
						log({ type: "api_error", error: errMsg });
					}
					const text = (msg.content as any[])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("");
					if (text) console.log(`\n${ts()} [Assistant]\n${text}`);
				}
				break;
			}

			case "agent_end":
				log({ type: "session_end", sessionId });
				console.log(`\n${ts()} Agent finished (${toolCallCount} tool calls)`);
				break;
		}
	}
} catch (e) {
	const errMsg = e instanceof Error ? e.message : String(e);
	log({ type: "fatal_error", error: errMsg });
	console.error("Agent error:", errMsg);
} finally {
	await mcpClient.close();
}
