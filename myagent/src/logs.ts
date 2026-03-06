/**
 * Session log explorer for .myagent/<uuid>.jsonl files.
 *
 * Usage:
 *   npm run logs              — list all sessions
 *   npm run logs last         — show the most recent session
 *   npm run logs <uuid>       — show a specific session by full or partial UUID
 *   npm run logs <index>      — show session by index from the list (0 = newest)
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOGS_DIR = join(process.cwd(), ".myagent");

function getSessions(): { file: string; id: string; mtime: number }[] {
	if (!existsSync(LOGS_DIR)) return [];
	return readdirSync(LOGS_DIR)
		.filter((f) => f.endsWith(".jsonl"))
		.map((f) => {
			const file = join(LOGS_DIR, f);
			const mtime = Number(readFileSync(file).toString().split("\n")[0] ? JSON.parse(readFileSync(file).toString().split("\n")[0]).ts : 0);
			return { file, id: f.replace(".jsonl", ""), mtime };
		})
		.sort((a, b) => b.mtime - a.mtime);
}

function readLines(file: string): any[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => {
			try { return JSON.parse(l); } catch { return null; }
		})
		.filter(Boolean);
}

function fmt(ts: number) {
	return new Date(ts).toLocaleString();
}

function duration(start: number, end: number) {
	const s = Math.round((end - start) / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function truncate(s: string, n = 80) {
	return s.length > n ? s.slice(0, n) + "…" : s;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function listSessions() {
	const sessions = getSessions();
	if (sessions.length === 0) {
		console.log("No sessions found in .myagent/");
		return;
	}

	console.log(`\nFound ${sessions.length} session(s) in ${LOGS_DIR}\n`);
	console.log("  #  Started               Duration  Model                     Prompt");
	console.log("  " + "─".repeat(90));

	sessions.forEach(({ file, id }, i) => {
		const lines = readLines(file);
		const start = lines.find((l) => l.type === "session_start");
		const end = lines.find((l) => l.type === "session_end");
		const err = lines.find((l) => l.type === "api_error" || l.type === "fatal_error");

		const startTs = start?.ts ?? lines[0]?.ts ?? 0;
		const endTs = end?.ts ?? lines[lines.length - 1]?.ts ?? startTs;
		const model = start?.model ?? "?";
		const promptText = start?.prompt?.[0]?.content ?? "";
		const status = err ? " ⚠" : "";

		console.log(
			`  ${String(i).padEnd(2)} ${fmt(startTs).padEnd(21)} ${duration(startTs, endTs).padEnd(9)} ${model.padEnd(25)} ${truncate(promptText, 40)}${status}`,
		);
		console.log(`     ${id}`);
	});
	console.log();
}

function showSession(file: string, id: string) {
	const lines = readLines(file);
	const start = lines.find((l) => l.type === "session_start");
	const end = lines.find((l) => l.type === "session_end");

	const startTs = start?.ts ?? lines[0]?.ts ?? 0;
	const endTs = end?.ts ?? lines[lines.length - 1]?.ts ?? startTs;

	console.log(`\n${"═".repeat(70)}`);
	console.log(`Session: ${id}`);
	console.log(`Started: ${fmt(startTs)}  |  Duration: ${duration(startTs, endTs)}`);
	if (start?.model) console.log(`Model:   ${start.model}`);
	console.log("═".repeat(70) + "\n");

	// Print initial prompt
	if (start?.prompt) {
		for (const msg of start.prompt) {
			console.log(`[${msg.role.toUpperCase()}] ${msg.content}`);
		}
		console.log();
	}

	// Replay events
	for (const line of lines) {
		const t = `[${fmt(line.ts)}]`;
		switch (line.type) {
			case "session_start":
			case "session_end":
				break;

			case "agent_start":
				console.log(`${t} Agent started`);
				break;

			case "turn_start":
				console.log(`\n${t} ── Turn ──`);
				break;

			case "tool_execution_start":
				console.log(`${t} → ${line.toolName}(${JSON.stringify(line.args)})`);
				break;

			case "tool_execution_end": {
				const text = (line.result?.content ?? [])
					.filter((c: any) => c.type === "text")
					.map((c: any) => c.text)
					.join("")
					.slice(0, 200);
				const tag = line.isError ? "ERROR" : "OK";
				console.log(`${t} ← ${line.toolName} [${tag}]${text ? ": " + truncate(text, 120) : ""}`);
				break;
			}

			case "message_end": {
				const msg = line.message;
				if (msg?.role === "assistant") {
					const text = (msg.content ?? [])
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("");
					if (msg.stopReason === "error") {
						console.log(`${t} [ASSISTANT ERROR] ${msg.errorMessage ?? "unknown"}`);
					} else if (text) {
						console.log(`\n${t} [ASSISTANT]\n${text}`);
					}
				}
				break;
			}

			case "api_error":
				console.log(`${t} ⚠ API error: ${truncate(line.error, 120)}`);
				break;

			case "fatal_error":
				console.log(`${t} ✗ Fatal error: ${line.error}`);
				break;

			case "agent_end":
				console.log(`\n${t} Agent finished (${lines.filter((l) => l.type === "tool_execution_start").length} tool calls)`);
				break;
		}
	}
	console.log();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const sessions = getSessions();

if (args.length === 0 || args[0] === "list") {
	listSessions();
} else if (args[0] === "last") {
	if (sessions.length === 0) { console.log("No sessions found."); process.exit(1); }
	showSession(sessions[0].file, sessions[0].id);
} else {
	const query = args[0];
	// Try as index
	const byIndex = sessions[Number(query)];
	// Try as UUID (full or partial)
	const byId = sessions.find((s) => s.id.startsWith(query));
	const target = byIndex ?? byId;
	if (!target) {
		console.error(`No session found for "${query}". Run \`npm run logs\` to list sessions.`);
		process.exit(1);
	}
	showSession(target.file, target.id);
}
