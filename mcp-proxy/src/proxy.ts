/**
 * leanprompt-mcp-proxy — sits between an MCP client (e.g. Claude Desktop) and
 * a real MCP server, compressing oversized tool results and sampling
 * requests with leanprompt before they reach the model.
 *
 * Four request types are handled today:
 *   - tools/call: the client -> server direction. We forward the call
 *     upstream, then compress the result's text content before returning it.
 *     A task-augmented call (params.task set) may come back as a
 *     CreateTaskResult (no `content`) instead of the real payload — nothing
 *     to compress yet, that's handled by tasks/result below.
 *   - tasks/result: retrieves the deferred payload of a completed task
 *     (2025-11-25 spec, experimental). Compressed the same way as a direct
 *     tools/call result once it's actually available.
 *   - tasks/get: status/polling only, no payload — passed straight through.
 *   - sampling/createMessage: the server -> client direction (the upstream
 *     server asking the connected client's model for a completion). We
 *     compress the outbound messages before relaying the request onward.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    CreateMessageRequestSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    GetTaskRequestSchema,
    GetTaskResultSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Middleware } from "leanprompt";

import { compressSamplingMessages, compressToolResult, EXT_ID } from "./compress.js";
import type { SamplingMessageLike, ToolResultLike } from "./compress.js";

export interface ProxyConfig {
    /** Command to spawn the real MCP server this proxy wraps. */
    command: string;
    args: string[];
    /** Below this many (leanprompt-estimated) tokens, content passes through untouched. */
    thresholdTokens: number;
    /** Extract keep-ratio for prose that clears the threshold. */
    keepRatio: number;
}

export async function runProxy(cfg: ProxyConfig): Promise<void> {
    const baseConfig = {
        mode: "on" as const,
        routing: { prose: "extract" },
        trigger: { thresholdTokens: cfg.thresholdTokens },
        extract: { ratio: cfg.keepRatio },
    };

    // Each tool result is wrapped as a lone single-message array (see
    // compress.ts) — lastTurns: 0 disables the "never touch the live turns"
    // protection that would otherwise always cover a 1-message array.
    const toolResultMw = new Middleware({ ...baseConfig, protect: { lastTurns: 0 } });

    // Sampling messages ARE a real conversation history, so the default
    // recency protection is the correct, intentional behavior here.
    const samplingMw = new Middleware(baseConfig);

    // We are the client from the real server's point of view. Declaring
    // `sampling` here is what tells that server it's allowed to ask us for
    // completions at all.
    const upstream = new Client(
        { name: "leanprompt-mcp-proxy", version: "0.1.0" },
        { capabilities: { sampling: {} } },
    );
    await upstream.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args }));

    // We are the server from Claude Desktop's point of view.
    const downstream = new Server(
        { name: "leanprompt-mcp-proxy", version: "0.1.0" },
        {
            capabilities: {
                tools: {},
                // Advertised even though we don't know whether the wrapped
                // server actually supports tasks: params.task is forwarded
                // as-is either way, so an upstream server that ignores it
                // just responds synchronously as normal (see callTool below).
                tasks: { requests: { tools: { call: {} } } },
                experimental: { [EXT_ID]: {} },
            },
        },
    );

    downstream.setRequestHandler(ListToolsRequestSchema, () => upstream.listTools());

    downstream.setRequestHandler(CallToolRequestSchema, async (request) => {
        const result = (await upstream.callTool(request.params)) as ToolResultLike;

        // Task-augmented calls return a CreateTaskResult — nothing to
        // compress yet, the real payload arrives later via tasks/result
        // below. Checked via the `task` field, not `content`'s shape: the
        // SDK's default CallToolResultSchema validation defaults `content`
        // to `[]` even on a CreateTaskResult, so an emptiness/array check
        // silently never distinguishes the two (confirmed against a live
        // task-augmented call — content came back as `[]` alongside `task`).
        if ("task" in result && result.task) {
            return result;
        }
        return compressToolResult(result, toolResultMw);
    });

    // Status/polling only, no payload to compress.
    downstream.setRequestHandler(GetTaskRequestSchema, (request) =>
        upstream.request({ method: "tasks/get", params: request.params }, GetTaskResultSchema),
    );

    // The deferred payload of a completed task. "The structure matches the
    // result type of the original request" (SDK doc comment) — for a
    // task-augmented tools/call, that's a CallToolResult (no `task` field
    // here, unlike the tools/call response above), so it gets the same
    // compression treatment as the synchronous path. GetTaskPayloadResultSchema
    // is `.loose()` with no defaulting, so — unlike the check this replaced
    // in the tools/call handler — content really is absent/non-array when
    // the task augmented some other, non-tool-call request type.
    downstream.setRequestHandler(GetTaskPayloadRequestSchema, async (request) => {
        const result = (await upstream.request(
            { method: "tasks/result", params: request.params },
            GetTaskPayloadResultSchema,
        )) as ToolResultLike;

        if (!Array.isArray(result.content)) {
            return result;
        }
        return compressToolResult(result, toolResultMw);
    });

    // Server -> client direction: the upstream server calls back into us
    // (its client) to ask for a completion; we compress and relay it to
    // whichever client is actually connected downstream (Claude Desktop).
    upstream.setRequestHandler(CreateMessageRequestSchema, async (request) => {
        const messages = request.params.messages as SamplingMessageLike[];
        const [compressed] = compressSamplingMessages(messages, samplingMw);
        // compressSamplingMessages only ever rewrites a content block's `text`
        // field in place (see compress.ts), so `compressed` still matches the
        // exact SDK content union — the cast just re-narrows from the
        // deliberately loose SamplingMessageLike shape used for testability.
        return downstream.createMessage({
            ...request.params,
            messages: compressed,
        } as Parameters<typeof downstream.createMessage>[0]);
    });

    await downstream.connect(new StdioServerTransport());
}
