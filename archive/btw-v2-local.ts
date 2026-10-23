/**
 * /btw — side-question side session, v2 multi-turn (pi port of Claude Code's built-in /btw)
 *
 * Behavior (mirrors Claude Code, plus multi-turn):
 * - Invocable ANY time, even while the main agent is streaming: pi executes
 *   extension commands immediately (agent-session.js: "Handles extension
 *   commands ... immediately, even during streaming"), so /btw never queues
 *   behind and never steers the main line.
 * - Spawns ONE isolated pi subprocess in RPC mode: --no-session, no
 *   main-conversation context, fresh system prompt. The side agent has full
 *   tools (read/bash/...) and can do real work to answer.
 * - Multi-turn follow-ups: the floating overlay has an input line. Enter sends
 *   the next question to the SAME child session (true conversational
 *   continuity). If the side agent is still working, the follow-up is queued
 *   via RPC streamingBehavior "followUp".
 * - Output lives in a transient floating overlay. Closing it (esc / ctrl+c)
 *   kills the side process and returns to the main line. Nothing is written to
 *   the main session file, nothing enters the main LLM context — zero
 *   pollution. The side conversation itself is ephemeral (no session file).
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Input, Markdown, matchesKey, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Resolve the pi binary the same way the official subagent extension does. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

type Item =
	| { kind: "q"; text: string }
	| { kind: "a"; text: string; open: boolean }
	| { kind: "tool"; line: string }
	| { kind: "sys"; text: string };

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

function describeTool(toolName: string, args: any): string {
	let brief = "";
	if (typeof args?.command === "string") brief = args.command;
	else if (typeof args?.path === "string") brief = args.path;
	else if (typeof args?.pattern === "string") brief = args.pattern;
	else if (args && typeof args === "object") {
		try {
			brief = JSON.stringify(args);
		} catch {
			brief = "";
		}
	}
	return `⚙ ${toolName} ${truncate(brief.replace(/\s+/g, " "), 72)}`;
}

async function runBtw(firstQuestion: string, ctx: ExtensionCommandContext): Promise<void> {
	const model = ctx.model!;
	const childArgs: string[] = ["--mode", "rpc", "--no-session", "--model", `${model.provider}/${model.id}`];
	if (ctx.thinkingLevel) childArgs.push("--thinking", ctx.thinkingLevel);

	await ctx.ui.custom(
		(tui, theme, _kb, done) => {
			const border = new DynamicBorder((s: string) => theme.fg("accent", s));
			const mdTheme = getMarkdownTheme();
			const input = new Input({ prompt: theme.fg("accent", "❯ ") });

			const items: Item[] = [];
			let scrollBack = 0; // 0 = follow tail; >0 = reading history
			let cachedLineCount = 0;
			let busy = true; // first prompt is in flight from the start
			let queuedCount = 0;
			let seq = 0;
			let toolCount = 0;
			let alive = true;
			let closed = false;
			let exitCode: number | null = null;
			let stderrTail = "";
			const startedAt = Date.now();

			let proc: ChildProcess | null = null;
			let timer: ReturnType<typeof setInterval> | null = null;

			const openAnswer = (): Extract<Item, { kind: "a" }> => {
				const last = items[items.length - 1];
				if (last && last.kind === "a" && last.open) return last;
				const item: Extract<Item, { kind: "a" }> = { kind: "a", text: "", open: true };
				items.push(item);
				return item;
			};

			const killChild = () => {
				if (!proc || !alive) return;
				alive = false;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (proc && proc.exitCode === null) proc.kill("SIGKILL");
				}, 5000);
			};

			const closeAll = () => {
				if (closed) return;
				closed = true;
				killChild();
				if (timer) clearInterval(timer);
				done(undefined);
			};

			const send = (obj: Record<string, unknown>) => {
				if (proc && alive && proc.stdin && proc.stdin.writable) {
					proc.stdin.write(JSON.stringify(obj) + "\n");
				}
			};

			const submitQuestion = (raw: string) => {
				const value = raw.trim();
				if (!value) return;
				if (!alive) {
					items.push({ kind: "sys", text: "side session 已退出，无法继续追问（esc 关闭后重新 /btw）" });
					return;
				}
				input.setValue("");
				items.push({ kind: "q", text: value });
				scrollBack = 0;
				if (busy) {
					send({ id: `btw-${++seq}`, type: "prompt", message: value, streamingBehavior: "followUp" });
					queuedCount++;
				} else {
					busy = true;
					send({ id: `btw-${++seq}`, type: "prompt", message: value });
				}
			};

			const container = new Container();

			const comp = {
				focused: true,
				render: (width: number): string[] => {
					const rows = tui.terminal?.rows ?? 40;
					const inner = Math.max(30, width - 2);
					const chrome = 5; // border x2 + title + status + input
					const budget = Math.max(4, rows - chrome - 3);

					// Build transcript lines.
					const lines: string[] = [];
					for (const item of items) {
						if (item.kind === "q") {
							const wrapped = wrapTextWithAnsi(item.text, inner - 2);
							wrapped.forEach((l, i) => {
								lines.push(i === 0 ? theme.fg("accent", theme.bold(`❯ ${l}`)) : theme.fg("accent", `  ${l}`));
							});
						} else if (item.kind === "tool") {
							lines.push(theme.fg("dim", truncate(item.line, inner)));
						} else if (item.kind === "sys") {
							wrapTextWithAnsi(item.text, inner - 2).forEach((l) => lines.push(theme.fg("warning", `! ${l}`)));
						} else {
							const md = new Markdown(item.text || (item.open ? "…" : ""), 0, 0, mdTheme);
							lines.push(...md.render(inner));
							if (item.open) lines.push(theme.fg("dim", "▌"));
						}
					}
					cachedLineCount = lines.length;

					// Tail window with optional scrollback.
					const end = Math.max(0, lines.length - scrollBack);
					const start = Math.max(0, end - budget);
					const windowed = lines.slice(start, end);

					container.clear();
					container.addChild(border);
					container.addChild(
						new Text(
							theme.fg("accent", theme.bold("btw · side session（隔离，主线不受影响）")) + theme.fg("dim", ` · ${ctx.cwd}`),
							1,
							0,
						),
					);
					for (const line of windowed) {
						container.addChild(new Text(line, 1, 0));
					}
					if (start > 0) {
						container.addChild(new Text(theme.fg("dim", `↑ 历史在前（pgup/pgdn，共 ${lines.length} 行）`), 1, 0));
					}
					if (stderrTail.trim()) {
						container.addChild(new Text(theme.fg("error", truncate(stderrTail.trim(), 300)), 1, 0));
					}

					const secs = Math.round((Date.now() - startedAt) / 1000);
					const failNote = exitCode !== null && exitCode !== 0 ? ` ⚠ 退出码 ${exitCode}` : "";
					let status: string;
					if (!alive) {
						status = `侧会话已结束${failNote} · esc 关闭返回主线`;
					} else if (busy) {
						status = `⏳ 回答中… ${toolCount} 次工具调用${queuedCount > 0 ? ` · ${queuedCount} 条追问排队中` : ""} · esc 关闭`;
					} else {
						status = `💬 可追问 · enter 发送 · pgup/pgdn 翻历史 · esc 关闭返回主线`;
					}
					container.addChild(new Text(theme.fg("dim", status), 1, 0));
					for (const line of input.render(inner)) {
						container.addChild(new Text(line, 1, 0));
					}
					container.addChild(border);
					return container.render(width);
				},
				invalidate: () => tui.requestRender(),
				handleInput: (data: string) => {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						closeAll();
						return;
					}
					if (matchesKey(data, "pageup")) {
						scrollBack = Math.min(cachedLineCount, scrollBack + 15);
						comp.invalidate();
						return;
					}
					if (matchesKey(data, "pagedown")) {
						scrollBack = Math.max(0, scrollBack - 15);
						comp.invalidate();
						return;
					}
					input.handleInput(data);
				},
				dispose: () => {
					killChild();
					if (timer) clearInterval(timer);
				},
			};

			input.onSubmit = (value: string) => submitQuestion(value);
			input.onEscape = () => closeAll();

			// Spawn the isolated side session (RPC, ephemeral).
			const invocation = getPiInvocation(childArgs);
			proc = spawn(invocation.command, invocation.args, {
				cwd: ctx.cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});

			let buffer = "";
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let ev: any;
				try {
					ev = JSON.parse(line);
				} catch {
					return;
				}

				if (ev.type === "response" && ev.command === "prompt" && ev.success === false) {
					items.push({ kind: "sys", text: `追问被拒绝：${truncate(String(ev.error ?? ev.message ?? "unknown"), 200)}` });
				} else if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
					const item = openAnswer();
					item.text += ev.assistantMessageEvent.delta ?? "";
				} else if (ev.type === "message_end" && ev.message?.role === "assistant") {
					const last = items[items.length - 1];
					if (last && last.kind === "a") last.open = false;
				} else if (ev.type === "tool_execution_start") {
					// Close any open answer before tool activity interleaves.
					const last = items[items.length - 1];
					if (last && last.kind === "a") last.open = false;
					items.push({ kind: "tool", line: describeTool(ev.toolName, ev.args) });
					toolCount++;
				} else if (ev.type === "agent_start") {
					busy = true;
				} else if (ev.type === "agent_end") {
					const last = items[items.length - 1];
					if (last && last.kind === "a") last.open = false;
					busy = false;
					queuedCount = 0;
				} else if (ev.type === "session" || ev.type === "turn_start" || ev.type === "turn_end") {
					// ignore lifecycle noise
				}
				comp.invalidate();
			};

			proc.stdout!.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() || "";
				for (const line of lines) processLine(line);
			});

			proc.stderr!.on("data", (data: Buffer) => {
				stderrTail = (stderrTail + data.toString()).slice(-600);
				comp.invalidate();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				exitCode = code;
				alive = false;
				busy = false;
				comp.invalidate();
			});
			proc.on("error", (err) => {
				stderrTail += `\n${err.message}`;
				alive = false;
				busy = false;
				comp.invalidate();
			});

			timer = setInterval(() => comp.invalidate(), 1000);

			// Kick off the first question.
			submitQuestion(firstQuestion);

			return comp;
		},
		{ overlay: true, overlayOptions: { width: "85%" } },
	);
}

export default function (pi: ExtensionAPI) {
	let running = false;

	pi.registerCommand("btw", {
		description:
			"Side-question side session (isolated pi subprocess, zero main-context pollution, multi-turn follow-ups). Usable even while the main agent is working. Usage: /btw <question>",
		handler: async (args, ctx) => {
			const question = (args ?? "").trim();
			if (!question) {
				ctx.ui.notify("用法：/btw <问题> —— 起一个隔离 side session，可在侧窗内连续追问；主线 context 不受影响", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw 需要 TUI 交互模式", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("未选择模型", "error");
				return;
			}
			if (running) {
				ctx.ui.notify("已有一个 /btw 在跑（esc 关闭后再试）", "error");
				return;
			}

			running = true;
			try {
				await runBtw(question, ctx);
			} catch (err) {
				ctx.ui.notify(`btw 失败: ${err instanceof Error ? err.message : String(err)}`, "error");
			} finally {
				running = false;
			}
		},
	});
}
