/**
 * leanprompt-mcp-proxy — sits between an MCP client (e.g. Claude Desktop) and
 * a real MCP server, compressing oversized tool results and sampling
 * requests with leanprompt before they reach the model.
 *
 * Everything else the wrapped server offers is forwarded verbatim, in both
 * directions, and the downstream capabilities mirror whatever the upstream
 * actually advertises (resources, prompts, logging, completions, plus
 * server->client notifications and client->server notifications).
 *
 * Five request types get special treatment:
 *   - tools/call: the client -> server direction. We forward the call
 *     upstream, then compress the result's text content before returning it.
 *     A task-augmented call (params.task set) may come back as a
 *     CreateTaskResult (no `content`) instead of the real payload — nothing
 *     to compress yet, that's handled by tasks/result below.
 *   - tasks/result: retrieves the deferred payload of a completed task
 *     (2025-11-25 spec, experimental). Compressed the same way as a direct
 *     tools/call result once it's actually available.
 *   - tasks/get: status/polling only, no payload — passed straight through.
 *   - tools/list: passed straight through.
 *   - sampling/createMessage: the server -> client direction (the upstream
 *     server asking the connected client's model for a completion). We
 *     compress the outbound messages before relaying the request onward.
 *
 * Cancellation propagates through AbortSignals, not by relaying the
 * notifications/cancelled message verbatim: the JSON-RPC request id in that
 * notification is connection-scoped, so forwarding it as-is would reference
 * a nonexistent (or wrong) upstream request. Instead every forwarded request
 * carries the downstream handler's `extra.signal`; when the downstream
 * client cancels, the SDK aborts that signal and emits
 * notifications/cancelled upstream with the correct upstream-side id.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AnyObjectSchema, AnySchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import {
    CallToolRequestSchema,
    CompleteRequestSchema,
    CompleteResultSchema,
    CreateMessageRequestSchema,
    EmptyResultSchema,
    GetPromptRequestSchema,
    GetPromptResultSchema,
    GetTaskPayloadRequestSchema,
    GetTaskPayloadResultSchema,
    GetTaskRequestSchema,
    GetTaskResultSchema,
    ListPromptsRequestSchema,
    ListPromptsResultSchema,
    ListResourcesRequestSchema,
    ListResourcesResultSchema,
    ListResourceTemplatesRequestSchema,
    ListResourceTemplatesResultSchema,
    ListRootsRequestSchema,
    ListToolsRequestSchema,
    LoggingMessageNotificationSchema,
    PingRequestSchema,
    ProgressNotificationSchema,
    PromptListChangedNotificationSchema,
    ReadResourceRequestSchema,
    ReadResourceResultSchema,
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
    RootsListChangedNotificationSchema,
    SetLevelRequestSchema,
    SubscribeRequestSchema,
    ToolListChangedNotificationSchema,
    UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
    ClientNotification,
    ClientRequest,
    ServerCapabilities,
    ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import { Middleware } from "leanprompt";

import { compressSamplingMessages, compressToolResult, EXT_ID } from "./compress.js";
import type { SamplingMessageLike, ToolResultLike } from "./compress.js";
import { ExpandStore } from "./expand-store.js";
import type { ExpandStoreOptions } from "./expand-store.js";
import { VERSION } from "./version.js";

export interface ProxyConfig {
    /** Command to spawn the real MCP server this proxy wraps. */
    command: string;
    args: string[];
    /** Below this many (leanprompt-estimated) tokens, content passes through untouched. */
    thresholdTokens: number;
    /** Extract keep-ratio for prose that clears the threshold. */
    keepRatio: number;
    /** Original-content store behind the leanprompt_expand tool; on by default. */
    expand?: ExpandOptions;
}

export interface ExpandOptions extends Partial<ExpandStoreOptions> {
    /** false disables the store, the tool, and the annotation entirely. */
    enabled?: boolean;
}

export interface CreateProxyOptions {
    /** Transport to the real upstream server (we are its client). */
    upstreamTransport: Transport;
    /** Transport to the downstream client (we are its server). */
    downstreamTransport: Transport;
    thresholdTokens: number;
    keepRatio: number;
    expand?: ExpandOptions;
}

export interface ProxyHandles {
    upstream: Client;
    downstream: Server;
}

type Caps = ServerCapabilities;

/**
 * Request methods forwarded verbatim client -> server, conditioned on the
 * mirrored upstream capability. The SDK refuses to register a downstream
 * handler whose capability we never advertised, and forwarding a method the
 * upstream never advertised would only produce a method-not-found error —
 * gating on the capability keeps both sides consistent.
 */
const FORWARDED_REQUESTS: ReadonlyArray<{
    requestSchema: AnyObjectSchema;
    resultSchema: AnySchema;
    supported: (caps: Caps) => boolean;
}> = [
    { requestSchema: ListResourcesRequestSchema, resultSchema: ListResourcesResultSchema, supported: (c) => Boolean(c.resources) },
    { requestSchema: ListResourceTemplatesRequestSchema, resultSchema: ListResourceTemplatesResultSchema, supported: (c) => Boolean(c.resources) },
    { requestSchema: ReadResourceRequestSchema, resultSchema: ReadResourceResultSchema, supported: (c) => Boolean(c.resources) },
    { requestSchema: SubscribeRequestSchema, resultSchema: EmptyResultSchema, supported: (c) => Boolean(c.resources?.subscribe) },
    { requestSchema: UnsubscribeRequestSchema, resultSchema: EmptyResultSchema, supported: (c) => Boolean(c.resources?.subscribe) },
    { requestSchema: ListPromptsRequestSchema, resultSchema: ListPromptsResultSchema, supported: (c) => Boolean(c.prompts) },
    { requestSchema: GetPromptRequestSchema, resultSchema: GetPromptResultSchema, supported: (c) => Boolean(c.prompts) },
    { requestSchema: SetLevelRequestSchema, resultSchema: EmptyResultSchema, supported: (c) => Boolean(c.logging) },
    { requestSchema: CompleteRequestSchema, resultSchema: CompleteResultSchema, supported: (c) => Boolean(c.completions) },
    // ping gets a forwarder rather than the SDK's built-in pong so a dead
    // upstream surfaces as failed pings instead of a zombie-looking proxy.
    { requestSchema: PingRequestSchema, resultSchema: EmptyResultSchema, supported: () => true },
];

/** Upstream -> downstream notifications forwarded verbatim. */
const UPSTREAM_NOTIFICATIONS: ReadonlyArray<AnyObjectSchema> = [
    ToolListChangedNotificationSchema,
    ResourceListChangedNotificationSchema,
    ResourceUpdatedNotificationSchema,
    PromptListChangedNotificationSchema,
    LoggingMessageNotificationSchema,
    ProgressNotificationSchema,
];

/** Downstream -> upstream notifications forwarded verbatim. */
const DOWNSTREAM_NOTIFICATIONS: ReadonlyArray<AnyObjectSchema> = [
    RootsListChangedNotificationSchema,
];

const EXPAND_TOOL = {
    name: "leanprompt_expand",
    description:
        "Return the original, uncompressed output of a tool result that " +
        "leanprompt compressed. Pass the ref from the [leanprompt] note at " +
        "the end of that result.",
    inputSchema: {
        type: "object" as const,
        properties: { ref: { type: "string" as const } },
        required: ["ref"],
    },
};

/**
 * Wire a downstream Server to an upstream Client over the given transports.
 * Returns once both sides are connected and the downstream handshake data
 * (capabilities, instructions) mirrors the upstream's.
 */
export async function createProxy(opts: CreateProxyOptions): Promise<ProxyHandles> {
    const baseConfig = {
        mode: "on" as const,
        routing: { prose: "extract" },
        trigger: { thresholdTokens: opts.thresholdTokens },
        extract: { ratio: opts.keepRatio },
    };

    // Each tool result is wrapped as a lone single-message array (see
    // compress.ts) — lastTurns: 0 disables the "never touch the live turns"
    // protection that would otherwise always cover a 1-message array.
    const toolResultMw = new Middleware({ ...baseConfig, protect: { lastTurns: 0 } });

    // Sampling messages ARE a real conversation history, so the default
    // recency protection is the correct, intentional behavior here.
    const samplingMw = new Middleware(baseConfig);

    // The expand store keeps the original content of every compressed
    // result so the leanprompt_expand tool can return it verbatim. On by
    // default; --no-expand disables store, tool, and annotation together.
    const expandStore =
        (opts.expand?.enabled ?? true) ? new ExpandStore(opts.expand) : undefined;

    // We are the client from the real server's point of view. Declaring
    // `sampling` tells that server it's allowed to ask us for completions;
    // `roots` lets it send us roots/list (forwarded to the downstream
    // client) and lets us relay its roots/list_changed notification. Both
    // must be declared here — client capabilities are fixed at connect time.
    const upstream = new Client(
        { name: "leanprompt-mcp-proxy", version: VERSION },
        { capabilities: { sampling: {}, roots: { listChanged: true } } },
    );
    await upstream.connect(opts.upstreamTransport);

    const upstreamCaps = upstream.getServerCapabilities() ?? {};

    // We are the server from the downstream client's point of view. The
    // advertised surface is whatever the upstream advertised — plus tasks,
    // always: params.task is forwarded as-is either way, so an upstream
    // server that ignores it just responds synchronously as normal (see
    // callTool below). EXT_ID marks the side-channel our stats ride in.
    const downstream = new Server(
        { name: "leanprompt-mcp-proxy", version: VERSION },
        {
            capabilities: {
                ...upstreamCaps,
                // Always advertise tools when expand is on: even a
                // tools-less upstream still exposes leanprompt_expand.
                ...(expandStore === undefined && upstreamCaps.tools === undefined
                    ? {}
                    : {
                          tools: {
                              ...upstreamCaps.tools,
                              listChanged: upstreamCaps.tools?.listChanged ?? false,
                          },
                      }),
                tasks: {
                    ...upstreamCaps.tasks,
                    requests: {
                        ...upstreamCaps.tasks?.requests,
                        tools: { call: {} },
                    },
                },
                experimental: { ...upstreamCaps.experimental, [EXT_ID]: {} },
            },
            instructions: upstream.getInstructions(),
        },
    );

    if (upstreamCaps.tools || expandStore !== undefined) {
        downstream.setRequestHandler(ListToolsRequestSchema, async () => {
            const listed = upstreamCaps.tools
                ? ((await upstream.listTools()) as { tools: unknown[] })
                : { tools: [] as unknown[] };
            if (expandStore === undefined) {
                return listed;
            }
            return { ...listed, tools: [...listed.tools, EXPAND_TOOL] };
        });

        downstream.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            // Answered locally: the original content of a compressed result,
            // verbatim — never recompressed, never annotated.
            if (expandStore !== undefined && request.params.name === EXPAND_TOOL.name) {
                const ref = (request.params.arguments as { ref?: unknown } | undefined)?.ref;
                const entry = typeof ref === "string" ? expandStore.get(ref) : undefined;
                if (entry === undefined) {
                    return {
                        isError: true,
                        content: [
                            {
                                type: "text" as const,
                                text:
                                    `leanprompt_expand: unknown or expired ref ` +
                                    `${String(ref)}. The original output is no ` +
                                    `longer available; re-run the original tool call.`,
                            },
                        ],
                    };
                }
                return { content: entry.content };
            }
            if (!upstreamCaps.tools) {
                return {
                    isError: true,
                    content: [
                        {
                            type: "text" as const,
                            text: "leanprompt: upstream exposes no tools",
                        },
                    ],
                };
            }

            // params — including _meta.progressToken — is forwarded verbatim
            // so upstream progress notifications correlate back to the
            // downstream client's token.
            const result = (await upstream.callTool(request.params, undefined, {
                signal: extra.signal,
            })) as ToolResultLike;

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
            return compressToolResult(result, toolResultMw, expandStore);
        });
    }

    // Status/polling only, no payload to compress.
    downstream.setRequestHandler(GetTaskRequestSchema, (request, extra) =>
        upstream.request(
            { method: "tasks/get", params: request.params },
            GetTaskResultSchema,
            { signal: extra.signal },
        ),
    );

    // The deferred payload of a completed task. "The structure matches the
    // result type of the original request" (SDK doc comment) — for a
    // task-augmented tools/call, that's a CallToolResult (no `task` field
    // here, unlike the tools/call response above), so it gets the same
    // compression treatment as the synchronous path. GetTaskPayloadResultSchema
    // is `.loose()` with no defaulting, so — unlike the check this replaced
    // in the tools/call handler — content really is absent/non-array when
    // the task augmented some other, non-tool-call request type.
    downstream.setRequestHandler(GetTaskPayloadRequestSchema, async (request, extra) => {
        const result = (await upstream.request(
            { method: "tasks/result", params: request.params },
            GetTaskPayloadResultSchema,
            { signal: extra.signal },
        )) as ToolResultLike;

        if (!Array.isArray(result.content)) {
            return result;
        }
        return compressToolResult(result, toolResultMw, expandStore);
    });

    // Everything else the upstream supports: verbatim pass-through. No
    // compression — a resources/read result could be big, but compressing
    // it is a separate decision (see README Limitations).
    for (const { requestSchema, resultSchema, supported } of FORWARDED_REQUESTS) {
        if (!supported(upstreamCaps)) {
            continue;
        }
        downstream.setRequestHandler(requestSchema, (request, extra) =>
            upstream.request(
                { method: request.method, params: request.params } as ClientRequest,
                resultSchema,
                { signal: extra.signal },
            ),
        );
    }

    for (const notificationSchema of UPSTREAM_NOTIFICATIONS) {
        upstream.setNotificationHandler(notificationSchema, (notification) =>
            downstream.notification(notification as ServerNotification),
        );
    }

    for (const notificationSchema of DOWNSTREAM_NOTIFICATIONS) {
        downstream.setNotificationHandler(notificationSchema, (notification) =>
            upstream.notification(notification as ClientNotification),
        );
    }

    // Server -> client direction: the upstream server calls back into us
    // (its client) to ask for a completion; we compress and relay it to
    // whichever client is actually connected downstream (Claude Desktop).
    upstream.setRequestHandler(CreateMessageRequestSchema, async (request, extra) => {
        const messages = request.params.messages as SamplingMessageLike[];
        const [compressed] = compressSamplingMessages(messages, samplingMw);
        // compressSamplingMessages only ever rewrites a content block's `text`
        // field in place (see compress.ts), so `compressed` still matches the
        // exact SDK content union — the cast just re-narrows from the
        // deliberately loose SamplingMessageLike shape used for testability.
        return downstream.createMessage(
            {
                ...request.params,
                messages: compressed,
            } as Parameters<typeof downstream.createMessage>[0],
            { signal: extra.signal },
        );
    });

    // roots/list: upstream asks its client (us) for the filesystem roots;
    // forward to the downstream client, which actually owns them.
    upstream.setRequestHandler(ListRootsRequestSchema, (request, extra) =>
        downstream.listRoots(request.params, { signal: extra.signal }),
    );

    await downstream.connect(opts.downstreamTransport);

    return { upstream, downstream };
}

export async function runProxy(cfg: ProxyConfig): Promise<void> {
    await createProxy({
        upstreamTransport: new StdioClientTransport({ command: cfg.command, args: cfg.args }),
        downstreamTransport: new StdioServerTransport(),
        thresholdTokens: cfg.thresholdTokens,
        keepRatio: cfg.keepRatio,
    });
}
