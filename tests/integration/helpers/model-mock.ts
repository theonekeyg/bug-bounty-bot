/**
 * Intercepts globalThis.fetch for LLM API calls and returns scripted responses.
 * Everything else passes through to the real fetch.
 *
 * Usage:
 *   const mock = new ModelMock();
 *   mock.enqueue(textResponse("STATUS:found"));
 *   mock.install();
 *   // ... run agent ...
 *   mock.uninstall();
 *   expect(mock.callCount).toBe(1);
 */

import type OpenAI from "openai";
import { __setFetchForTesting } from "../../../src/sdk/client.js";

export type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;

// ── Response builders ──────────────────────────────────────────────────────────

let _seq = 0;

/** Build a response where the model wants to call one or more tools. */
export function toolCallResponse(
  calls: Array<{ name: string; args: Record<string, unknown>; id?: string }>,
): ChatCompletion {
  return {
    id: `chatcmpl-mock-${++_seq}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "qwen/qwen-plus",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: calls.map((c, i) => ({
            id: c.id ?? `call_mock_${_seq}_${i}`,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.args) },
          })),
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  };
}

/** Build a final text response (no tool calls). */
export function textResponse(text: string): ChatCompletion {
  return {
    id: `chatcmpl-mock-${++_seq}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "qwen/qwen-plus",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text, refusal: null },
        finish_reason: "stop",
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 120, completion_tokens: 60, total_tokens: 180 },
  };
}

// ── Recorded call ──────────────────────────────────────────────────────────────

export interface RecordedCall {
  /** Messages sent to the model on this turn. */
  messages: Array<{ role: string; content: unknown }>;
  /** Tools advertised to the model. */
  tools: unknown[] | undefined;
}

// ── ModelMock ─────────────────────────────────────────────────────────────────

export class ModelMock {
  private queue: ChatCompletion[] = [];
  private _calls: RecordedCall[] = [];

  /** Queue responses to return in order. Throws if the queue is exhausted. */
  enqueue(...responses: ChatCompletion[]): this {
    this.queue.push(...responses);
    return this;
  }

  /**
   * Inject this mock's fetch into the SDK client.
   * Must be called before the agent runs (clears the OpenAI client cache).
   */
  install(): void {
    const self = this;
    __setFetchForTesting(async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : (input as Request).url;

      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      self._calls.push({
        messages: (body["messages"] as RecordedCall["messages"]) ?? [],
        tools: body["tools"] as unknown[] | undefined,
      });

      const next = self.queue.shift();
      if (!next) {
        throw new Error(
          `ModelMock: queue exhausted on call #${self._calls.length} to ${url}`,
        );
      }
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
  }

  /** Remove the fetch override and clear the client cache. */
  uninstall(): void {
    __setFetchForTesting(undefined);
  }

  get callCount(): number {
    return this._calls.length;
  }

  /** Return the recorded call at zero-based index. */
  call(index: number): RecordedCall {
    const c = this._calls[index];
    if (!c) throw new Error(`ModelMock: no call at index ${index}`);
    return c;
  }

  get calls(): readonly RecordedCall[] {
    return this._calls;
  }
}
