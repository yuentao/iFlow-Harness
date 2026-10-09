import * as http from "node:http";
import * as https from "node:https";
import { errorMessage } from "./jsonrpc.js";
import type { ActiveEndpoint } from "./models-query.js";

/** Result of one direct gateway completion. */
export interface CompletionResult {
  /** Accumulated assistant text (partial when reason is timeout/stalled). */
  text: string;
  /** Why the stream ended: a clean stop, the wall-clock ceiling, a stalled
   * stream, a transport/HTTP failure, or an external cancel (user dismissed
   * the enhancement — never salvage a cancelled partial). */
  reason: "complete" | "timeout" | "stalled" | "failed" | "cancelled";
}

export interface CompletionOptions {
  /** Hard wall-clock ceiling for the whole turn. */
  timeoutMs: number;
  /** Abort when the SSE stream produced nothing for this long. */
  idleMs: number;
  /** External abort (panel disposal / user cancel). `onAbort` registers a
   * synchronous cancel hook so a user-initiated cancel settles the promise
   * immediately (the panel releases its internal-prompt lane in the same
   * tick — re-clicking enhance right after a cancel is not busy-rejected);
   * signals without the hook fall back to a 500ms poll. */
  signal?: { aborted: boolean; onAbort?: (cancel: () => void) => void };
}

/** `https://host/v1` → `https://host/v1/chat/completions` (idempotent, trims
 * slashes, defaults to https for scheme-less user-typed baseUrls — mirrors
 * normalizeModelsUrl in models-query.ts). */
export function normalizeCompletionsUrl(baseUrl: string): string {
  let trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(trimmed)) trimmed = `https://${trimmed}`;
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
}

/**
 * Parse one SSE line. Returns the text delta (content only — reasoning
 * deltas count as liveness but never enter the answer), null for a non-data
 * line, or the sentinel "done" for the stream terminator.
 */
export function parseSseLine(line: string): string | "done" | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const payload = trimmed.slice(5).trim();
  if (!payload) return null;
  if (payload === "[DONE]") return "done";
  try {
    const event = JSON.parse(payload) as {
      choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
    };
    const delta = event.choices?.[0]?.delta;
    // reasoning_content is thinking-model chatter — never the answer.
    return typeof delta?.content === "string" ? delta.content : "";
  } catch {
    return ""; // malformed keep-alive chunk: liveness only
  }
}

/**
 * One-shot chat completion straight against the OpenAI-compatible endpoint
 * (POST {baseUrl}/chat/completions, stream: true), bypassing the CLI.
 *
 * Fourth-wave root cause (gateway-probed 2026-10-09, AGENTS.md pitfall #26):
 * an internal prompt routed through the CLI carries ~61K tokens of fixed
 * input (system prompt + every tool schema), which pushes thinking models
 * into 180s+ reasoning loops that never produce content — while the very same
 * enhance task, sent directly with a minimal prompt, converged in 60.3s
 * (test/fixtures/probe-gateway-sse.mjs). Enhancement / AI titles are plain
 * text rewrites: they never needed the agent session in the first place.
 *
 * Transport deliberately uses raw node:http(s) like models-query.ts: the VSCode
 * extension host patches global fetch with a proxy agent that throws on SOCKS
 * / scheme-less system proxies (pitfall #2).
 *
 * Salvage semantics: on timeout/stalled the text accumulated so far is
 * returned with the reason set — a slow gateway often has the FULL answer
 * streamed while the turn-stop never arrives. `failed` discards (a transport
 * error's partial is not trustworthy). apiKey only ever enters the
 * Authorization header — never logged.
 */
export async function streamChatCompletion(
  endpoint: ActiveEndpoint,
  model: string,
  prompt: string,
  opts: CompletionOptions,
): Promise<CompletionResult> {
  let url: URL;
  try {
    url = new URL(normalizeCompletionsUrl(endpoint.baseUrl));
  } catch {
    return { text: "", reason: "failed" };
  }
  const body = JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
  });
  const transport = url.protocol === "http:" ? http : https;
  return new Promise<CompletionResult>((resolve) => {
    let text = "";
    let settled = false;
    let lastActivity = Date.now();
    let idleTimer: NodeJS.Timeout | null = null;
    let signalTimer: NodeJS.Timeout | null = null;
    const finish = (reason: CompletionResult["reason"]) => {
      if (settled) return;
      settled = true;
      if (ceiling) clearTimeout(ceiling);
      if (idleTimer) clearTimeout(idleTimer);
      if (signalTimer) clearTimeout(signalTimer);
      try {
        req.destroy();
      } catch {
        // already dead
      }
      resolve({ text, reason });
    };
    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.apiKey}`,
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        if ((res.statusCode ?? 0) < 200 || (res.statusCode ?? 0) >= 300) {
          res.resume();
          finish("failed");
          return;
        }
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (chunk: string) => {
          lastActivity = Date.now();
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx);
            buf = buf.slice(idx + 1);
            const parsed = parseSseLine(line);
            if (parsed === "done") {
              finish("complete");
              return;
            }
            if (parsed) text += parsed;
          }
        });
        res.on("end", () => finish(text ? "complete" : "failed"));
        res.on("error", () => finish(text ? "complete" : "failed"));
      },
    );
    const ceiling = setTimeout(() => finish("timeout"), opts.timeoutMs);
    // Idle watchdog: SSE keep-alives and reasoning deltas both refresh the
    // stamp; total silence past the window means the stream wedged.
    const tick = () => {
      if (settled) return;
      if (Date.now() - lastActivity >= opts.idleMs) {
        finish("stalled");
        return;
      }
      idleTimer = setTimeout(tick, Math.max(250, Math.floor(opts.idleMs / 4)));
    };
    idleTimer = setTimeout(tick, opts.idleMs);
    // Cancel path: with an onAbort hook the caller gets a synchronous
    // teardown (immediate settle + socket destroy); the 500ms poll stays as
    // the fallback for plain signals — a dismissed enhancement tears the
    // gateway connection down within 500ms either way.
    if (opts.signal) {
      opts.signal.onAbort?.(() => finish("cancelled"));
      const pollSignal = () => {
        if (settled) return;
        if (opts.signal?.aborted) {
          finish("cancelled");
          return;
        }
        signalTimer = setTimeout(pollSignal, 500);
      };
      signalTimer = setTimeout(pollSignal, 500);
    }
    req.on("error", (error) => {
      // A destroy() from finish() surfaces here too — settled guards it.
      if (!settled && errorMessage(error).includes("socket hang up") && text) {
        finish("complete");
        return;
      }
      finish("failed");
    });
    req.write(body);
    req.end();
  });
}
