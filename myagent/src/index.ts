import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL("../../.env", import.meta.url).pathname });

import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { agentLoop } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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

console.log("Starting agent...\n");
console.log(`Session log: ${sessionFile}\n`);

const { client: mcpClient, agentTools } = await createBrowserTools();

const prompt = [
	{
		role: "user" as const,
		content: "Go to https://news.ycombinator.com and tell me the top 5 story titles.",
		timestamp: Date.now(),
	},
];

log({ type: "session_start", sessionId, model: model.id, prompt });

const context = {
	systemPrompt:
		"You are a browser automation agent. Use the browser tools to navigate and extract information from web pages.",
	messages: [] as any[],
	tools: agentTools,
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

const stream = agentLoop(prompt, context, config);

try {
	for await (const event of stream) {
		log(event);

		switch (event.type) {
			case "tool_execution_start":
				console.log(`→ ${event.toolName}(${JSON.stringify(event.args)})`);
				break;

			case "tool_execution_end":
				if (!event.isError) {
					const text = (event.result.content as any[])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("");
					console.log(`← ${event.toolName}: ${text.slice(0, 120)}${text.length > 120 ? "…" : ""}`);
				} else {
					console.error(`← ${event.toolName} error: ${(event.result.content as any[])[0]?.text}`);
				}
				break;

			case "message_end": {
				const msg = event.message as any;
				if (msg.role === "assistant") {
					if (msg.stopReason === "error") {
						const errMsg = msg.errorMessage ?? "unknown error";
						console.error(`\nAPI error: ${errMsg}`);
						log({ type: "api_error", error: errMsg });
					}
					const text = (msg.content as any[])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("");
					if (text) console.log(`\nAssistant: ${text}`);
				}
				break;
			}

			case "agent_end":
				log({ type: "session_end", sessionId });
				console.log("\nDone.");
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
