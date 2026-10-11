import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
    CallToolRequestSchema,
    EmptyResultSchema,
    GetPromptRequestSchema,
    ListPromptsRequestSchema,
    ListResourcesRequestSchema,
    ListToolsRequestSchema,
    ReadResourceRequestSchema,
    ResourceListChangedNotificationSchema,
    SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { createProxy, type ProxyHandles } from "../src/proxy.js";
import { EXT_ID } from "../src/compress.js";

const LONG_PROSE =
    "The quarterly report shows revenue grew twelve percent year over year. " +
    "Customer churn dropped to four percent, the lowest in company history. " +
    "The support team closed eighteen hundred tickets last month alone. " +
    "Engineering shipped the new billing system three weeks ahead of schedule. " +
    "Marketing spend stayed flat while lead volume increased by a third. " +
    "The board asked for a follow-up analysis of the enterprise segment. " +
    "Finance flagged a small discrepancy in the March invoicing numbers. " +
    "Overall sentiment among the leadership team remains cautiously optimistic.";

/** Everything the fake upstream advertises and serves. */
interface FakeUpstream {
    server: Server;
    /** Set to the params of the last logging/setLevel that reached upstream. */
    lastLogLevel: () => unknown;
}

function makeFakeUpstream(): FakeUpstream {
    let logLevel: unknown;
    const server = new Server(
        { name: "fake-upstream", version: "9.9.9" },
        {
            capabilities: {
                tools: { listChanged: true },
                resources: { subscribe: true, listChanged: true },
                prompts: { listChanged: true },
                logging: {},
            },
            instructions: "fake upstream instructions",
        },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
        tools: [
            { name: "big", description: "returns long prose", inputSchema: { type: "object" as const } },
            { name: "small", description: "returns a short string", inputSchema: { type: "object" as const } },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, (request) => ({
        content: [
            {
                type: "text" as const,
                text: request.params.name === "big" ? LONG_PROSE : "done",
            },
        ],
    }));
    server.setRequestHandler(ListResourcesRequestSchema, () => ({
        resources: [{ uri: "file:///x.txt", name: "x.txt" }],
    }));
    server.setRequestHandler(ReadResourceRequestSchema, (request) => ({
        contents: [{ uri: request.params.uri, text: "resource body" }],
    }));
    server.setRequestHandler(ListPromptsRequestSchema, () => ({
        prompts: [{ name: "greet" }],
    }));
    server.setRequestHandler(GetPromptRequestSchema, () => ({
        messages: [{ role: "user" as const, content: { type: "text" as const, text: "prompt text" } }],
    }));
    server.setRequestHandler(SetLevelRequestSchema, (request) => {
        logLevel = request.params.level;
        return {};
    });

    return { server, lastLogLevel: () => logLevel };
}

interface Rig {
    client: Client;
    proxy: ProxyHandles;
    upstream: FakeUpstream;
}

async function makeRig(
    upstream: FakeUpstream | Server = makeFakeUpstream(),
): Promise<Rig> {
    const server = upstream instanceof Server ? upstream : upstream.server;
    const [upstreamServerSide, proxyClientSide] = InMemoryTransport.createLinkedPair();
    await server.connect(upstreamServerSide);

    const [proxyServerSide, clientSide] = InMemoryTransport.createLinkedPair();
    const proxy = await createProxy({
        upstreamTransport: proxyClientSide,
        downstreamTransport: proxyServerSide,
        thresholdTokens: 5,
        keepRatio: 0.5,
    });

    const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
    await client.connect(clientSide);
    return { client, proxy, upstream: upstream as FakeUpstream };
}

describe("mcp-proxy e2e (in-memory)", () => {
    test("client sees mirrored upstream capabilities", async () => {
        const { client } = await makeRig();
        const caps = client.getServerCapabilities()!;
        expect(caps.tools).toBeDefined();
        expect(caps.resources).toBeDefined();
        expect(caps.prompts).toBeDefined();
        expect(caps.logging).toBeDefined();
        // tasks + our stats extension are always advertised on top.
        expect(caps.tasks).toBeDefined();
        expect(caps.experimental?.[EXT_ID]).toBeDefined();
        expect(client.getInstructions()).toBe("fake upstream instructions");
    });

    test("resources/list, resources/read, prompts/get round-trip verbatim", async () => {
        const { client } = await makeRig();
        const resources = await client.listResources();
        expect(resources.resources).toEqual([{ uri: "file:///x.txt", name: "x.txt" }]);
        const read = await client.readResource({ uri: "file:///x.txt" });
        expect(read.contents).toEqual([{ uri: "file:///x.txt", text: "resource body" }]);
        const prompt = await client.getPrompt({ name: "greet" });
        expect(prompt.messages[0]!.content).toEqual({ type: "text", text: "prompt text" });
    });

    test("tools/call compresses a long result and attaches stats; short result untouched", async () => {
        const { client } = await makeRig();
        const big = await client.callTool({ name: "big", arguments: {} });
        const block = big.content[0] as { type: string; text: string };
        expect(block.text.length).toBeLessThan(LONG_PROSE.length);
        expect((big._meta as Record<string, { tokensSaved: number }>)[EXT_ID].tokensSaved).toBeGreaterThan(0);

        const small = await client.callTool({ name: "small", arguments: {} });
        expect((small.content[0] as { text: string }).text).toBe("done");
        expect(small._meta?.[EXT_ID]).toBeUndefined();
    });

    test("upstream resources/list_changed notification reaches the client", async () => {
        const { client, upstream } = await makeRig();
        let seen = 0;
        client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
            seen++;
        });
        await upstream.server.sendResourceListChanged();
        await new Promise((r) => setTimeout(r, 20));
        expect(seen).toBe(1);
    });

    test("leanprompt_expand: listed, returns the original verbatim, bogus ref errors", async () => {
        const { client } = await makeRig();

        const tools = await client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain("big");
        expect(names).toContain("leanprompt_expand");

        // Compressed result carries the note with a resolvable ref.
        const big = await client.callTool({ name: "big", arguments: {} });
        const note = big.content[big.content.length - 1] as { type: string; text: string };
        expect(note.type).toBe("text");
        expect(note.text).toContain("[leanprompt]");
        const ref = note.text.match(/ref "(lp-[^"]+)"/)?.[1];
        expect(ref).toBeDefined();

        // Expand returns the exact original content array, unannotated.
        const expanded = await client.callTool({ name: "leanprompt_expand", arguments: { ref } });
        expect(expanded.isError).not.toBe(true);
        expect(expanded.content).toEqual([{ type: "text", text: LONG_PROSE }]);

        const bogus = await client.callTool({
            name: "leanprompt_expand",
            arguments: { ref: "lp-00000000" },
        });
        expect(bogus.isError).toBe(true);
        expect((bogus.content[0] as { text: string }).text).toContain("unknown or expired ref");
    });

    test("a tools-less upstream still exposes leanprompt_expand", async () => {
        const bare = new Server(
            { name: "bare-upstream", version: "1.0.0" },
            { capabilities: { logging: {} } },
        );
        const { client } = await makeRig(bare);

        const caps = client.getServerCapabilities()!;
        expect(caps.tools).toBeDefined();
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toEqual(["leanprompt_expand"]);

        const miss = await client.callTool({ name: "anything", arguments: {} });
        expect(miss.isError).toBe(true);
        expect((miss.content[0] as { text: string }).text).toContain("no tools");
    });

    test("logging/setLevel forwarded to upstream", async () => {
        const { client, upstream } = await makeRig();
        const out = await client.request(
            { method: "logging/setLevel", params: { level: "debug" } },
            EmptyResultSchema,
        );
        expect(out).toEqual({});
        expect(upstream.lastLogLevel()).toBe("debug");
    });
});

interface HttpUpstreamRig {
    url: string;
    /** The X-Test-Auth header of the most recent request that reached upstream. */
    lastAuthHeader: () => string | undefined;
    close: () => Promise<void>;
}

/**
 * The fake upstream served over real Streamable HTTP on an ephemeral port —
 * a single stateful session is enough for the one client each test runs.
 */
async function makeHttpUpstreamRig(): Promise<HttpUpstreamRig> {
    const upstream = makeFakeUpstream();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await upstream.server.connect(transport);

    let lastAuthHeader: string | undefined;
    const httpServer = createServer((req, res) => {
        const auth = req.headers["x-test-auth"];
        lastAuthHeader = Array.isArray(auth) ? auth[0] : auth;
        void transport.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as { port: number };

    return {
        url: `http://127.0.0.1:${port}/mcp`,
        lastAuthHeader: () => lastAuthHeader,
        close: async () => {
            await upstream.server.close();
            if (httpServer.listening) {
                httpServer.closeAllConnections();
                await new Promise<void>((resolve) => httpServer.close(() => resolve()));
            }
        },
    };
}

describe("mcp-proxy e2e (remote upstream over streamable http)", () => {
    // The whole topology for real: test client --stdio--> spawned proxy
    // process (--url/--header/--threshold) --http--> upstream MCP server.
    test("spawned `--url` proxy compresses tool results and forwards --header", async () => {
        const http = await makeHttpUpstreamRig();
        const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

        const client = new Client({ name: "test-client", version: "0.0.1" }, { capabilities: {} });
        const transport = new StdioClientTransport({
            command: process.execPath,
            args: [
                cliPath,
                "--url", http.url,
                "--header", "X-Test-Auth: token-123",
                "--threshold", "5",
                "--keep-ratio", "0.5",
            ],
            stderr: "inherit",
        });

        try {
            await client.connect(transport);

            const big = await client.callTool({ name: "big", arguments: {} });
            const block = big.content[0] as { type: string; text: string };
            expect(block.text.length).toBeLessThan(LONG_PROSE.length);
            expect((big._meta as Record<string, { tokensSaved: number }>)[EXT_ID].tokensSaved).toBeGreaterThan(0);

            const small = await client.callTool({ name: "small", arguments: {} });
            expect((small.content[0] as { text: string }).text).toBe("done");
            expect(small._meta?.[EXT_ID]).toBeUndefined();

            expect(http.lastAuthHeader()).toBe("token-123");
        } finally {
            await client.close();
            await http.close();
        }
    });
});
