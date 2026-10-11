/**
 * Expand store — holds the original content of compressed tool results so
 * the `leanprompt_expand` tool can return them verbatim on demand.
 *
 * In-memory only: refs die with the proxy process. Bounded by an entry cap
 * and a byte cap (JSON-serialized content); least-recently-used entries are
 * evicted first.
 */

export interface ExpandEntry {
    content: unknown[];
    storedAt: number;
    /** leanprompt-estimated tokens of the original result. */
    tokens: number;
}

export interface ExpandStoreOptions {
    /** Max entries kept (LRU eviction beyond this). */
    maxEntries: number;
    /** Max total bytes of JSON-serialized content kept. */
    maxBytes: number;
}

const DEFAULT_MAX_ENTRIES = 256;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export class ExpandStore {
    private readonly maxEntries: number;
    private readonly maxBytes: number;
    // Map preserves insertion order; get() re-inserts to mark recent use.
    private readonly entries = new Map<string, ExpandEntry>();
    private bytes = 0;
    private counter = 0;

    constructor(options?: Partial<ExpandStoreOptions>) {
        this.maxEntries = options?.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
    }

    /** Store original content; returns the ref to quote in the annotation. */
    put(content: unknown[], tokens: number): string {
        // lp- + 8 base36 chars: 4 low digits of the timestamp + a per-process
        // sequence (grows past 4 chars only after 1.7M puts — still unique).
        const stamp = Date.now().toString(36).slice(-4);
        const seq = (this.counter++).toString(36).padStart(4, "0");
        const ref = `lp-${stamp}${seq}`;
        const entry: ExpandEntry = { content, storedAt: Date.now(), tokens };
        this.entries.set(ref, entry);
        this.bytes += JSON.stringify(content).length;
        this.evict();
        return ref;
    }

    /** Fetch and mark as recently used. */
    get(ref: string): ExpandEntry | undefined {
        const entry = this.entries.get(ref);
        if (entry === undefined) {
            return undefined;
        }
        this.entries.delete(ref);
        this.entries.set(ref, entry);
        return entry;
    }

    get size(): number {
        return this.entries.size;
    }

    private evict(): void {
        while (
            this.entries.size > this.maxEntries ||
            this.bytes > this.maxBytes
        ) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) {
                break;
            }
            const evicted = this.entries.get(oldest)!;
            this.entries.delete(oldest);
            this.bytes -= JSON.stringify(evicted.content).length;
        }
    }
}
