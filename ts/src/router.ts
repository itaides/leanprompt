/**
 * Router — picks a Compressor for a given ContentType.
 *
 * Used by the Middleware pipeline after classification:
 *
 *     for (const msg of messages) {
 *         const ctype = classify(msg);
 *         const c = router.route(ctype);
 *         const [out, stats] = c.compress([msg]);
 *     }
 *
 * Safe default: any unmapped ContentType falls back to Verbatim. Never
 * corrupts content just because a configuration entry is missing.
 */

import type { Compressor } from "./compressors/base.js";
import { Verbatim } from "./compressors/verbatim.js";
import type { ContentType } from "./types.js";

/** Static mapping from ContentType to Compressor. */
export class Router {
    private routes: Map<ContentType, Compressor>;
    private readonly defaultCompressor: Compressor;

    constructor(
        routes?: Map<ContentType, Compressor> | null,
        defaultCompressor?: Compressor | null,
    ) {
        this.routes = new Map(routes ?? []);
        this.defaultCompressor = defaultCompressor ?? new Verbatim();
    }

    get default(): Compressor {
        return this.defaultCompressor;
    }

    /** Register (or overwrite) a mapping after construction. */
    register(contentType: ContentType, compressor: Compressor): void {
        this.routes.set(contentType, compressor);
    }

    /** Return the Compressor for a ContentType, or the default. */
    route(contentType: ContentType): Compressor {
        return this.routes.get(contentType) ?? this.defaultCompressor;
    }
}
