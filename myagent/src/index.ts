import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL("../../.env", import.meta.url).pathname });
import { getModel, getEnvApiKey } from "@mariozechner/pi-ai";
import { agentLoop } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const weatherTool = {
	name: "get_weather",
	label: "Get Weather",
	description: "Get the current weather for a city.",
	parameters: Type.Object({
		city: Type.String({ description: "The city name to get weather for." }),
	}),
	execute: async (_toolCallId: string, { city }: { city: string }) => {
		// Stub: replace with a real weather API call
		const temp = Math.round(15 + Math.random() * 20);
		const conditions = ["sunny", "cloudy", "rainy", "windy"][Math.floor(Math.random() * 4)];
		return {
			content: [{ type: "text" as const, text: `Weather in ${city}: ${temp}°C, ${conditions}` }],
			details: { city, temp, conditions },
		};
	},
};

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const model = getModel("anthropic", "claude-sonnet-4-5");

const context = {
	systemPrompt: "You are a helpful assistant. Use tools when needed.",
	messages: [] as any[],
	tools: [weatherTool],
};

const apiKey = getEnvApiKey("anthropic");
if (!apiKey) {
	console.error("Missing ANTHROPIC_API_KEY environment variable.");
	process.exit(1);
}

const config = {
	model,
	apiKey,

	// Pass standard LLM messages through; filter out any custom message types here
	convertToLlm: (messages: any[]) => messages,
};

const prompt = [
	{
		role: "user" as const,
		content: "What's the weather like in Tokyo and Paris?",
		timestamp: Date.now(),
	},
];

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

const sessionId = randomUUID();
const { file: sessionFile, log } = createSessionLogger(sessionId);

console.log("Starting agent...\n");
console.log(`Session log: ${sessionFile}\n`);
log({ type: "session_start", sessionId, model: model.id, prompt });

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
					console.log(`← ${event.toolName}: ${text}`);
				} else {
					console.error(`← ${event.toolName} error: ${event.result.content[0]?.text}`);
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
	process.exit(1);
}
