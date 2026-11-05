/**
 * Per-million-token pricing in USD for Anthropic models. Used to convert
 * recorded token counts in stat_entries into estimated dollar cost in the
 * token-usage report.
 *
 * IMPORTANT: prices below are best-known values from public Anthropic docs as
 * of 2026-11. They are NOT auto-fetched. When Anthropic updates pricing,
 * update this file. A model that isn't in this table is treated as "unpriced"
 * (cost contribution = 0); aggregations still report token counts so unpriced
 * usage stays visible.
 */

export type ModelPrice = { input_per_mtok: number; output_per_mtok: number; cache_read_per_mtok?: number };

/** Standard cache prices relative to input, for models with no explicit read price. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

const PRICES: Record<string, ModelPrice> = {
    // Haiku family
    'claude-haiku-3-5-20241022':   { input_per_mtok: 0.80, output_per_mtok: 4 },
    'claude-haiku-3-5':            { input_per_mtok: 0.80, output_per_mtok: 4 },
    'claude-haiku-4-5-20251001':   { input_per_mtok: 1,    output_per_mtok: 5 },
    'claude-haiku-4-5':            { input_per_mtok: 1,    output_per_mtok: 5 },

    // Sonnet family — pricing held at $3/$15 across 3.5 → 4.x
    'claude-sonnet-3-5-20241022':  { input_per_mtok: 3,    output_per_mtok: 15 },
    'claude-sonnet-3-5':           { input_per_mtok: 3,    output_per_mtok: 15 },
    'claude-sonnet-4-20250514':    { input_per_mtok: 3,    output_per_mtok: 15 },
    'claude-sonnet-4-5-20250929':  { input_per_mtok: 3,    output_per_mtok: 15 },
    'claude-sonnet-4-5':           { input_per_mtok: 3,    output_per_mtok: 15 },
    'claude-sonnet-4-6':           { input_per_mtok: 3,    output_per_mtok: 15 },
    'claude-sonnet-5-5':           { input_per_mtok: 2,    output_per_mtok: 10, cache_read_per_mtok: 0.20 },

    // Opus family
    'claude-opus-3-20240229':      { input_per_mtok: 15,   output_per_mtok: 75 },
    'claude-opus-3':               { input_per_mtok: 15,   output_per_mtok: 75 },
    'claude-opus-4-5-20251101':    { input_per_mtok: 15,   output_per_mtok: 75 },
    'claude-opus-4-5':             { input_per_mtok: 15,   output_per_mtok: 75 },
    'claude-opus-4-7':             { input_per_mtok: 5,    output_per_mtok: 25 },
    'claude-opus-5-5':             { input_per_mtok: 4,    output_per_mtok: 20, cache_read_per_mtok: 0.20 },
};

/** Resolve a model id to its pricing entry. Falls back to a date-suffix-stripped
 * key (e.g. `claude-sonnet-4-5-20250929` → `claude-sonnet-4-5`) so a single
 * `claude-sonnet-4-5` row covers all dated revisions. */
export function pricingFor(model: string | null | undefined): ModelPrice | null {
    if (!model) return null;
    if (PRICES[model]) return PRICES[model];
    const stripped = model.replace(/-\d{8}$/, '');
    return PRICES[stripped] ?? null;
}

/** USD cost for a (model, input_tokens, output_tokens) tuple. Returns 0 for
 * unknown models so the caller can sum freely without NaN. Use `pricingFor` to
 * detect "unpriced" explicitly when needed. */
export function estimateCostUsd(model: string | null | undefined, inputTokens: number, outputTokens: number): number {
    const p = pricingFor(model);
    if (!p) return 0;
    return (inputTokens * p.input_per_mtok + outputTokens * p.output_per_mtok) / 1_000_000;
}

/** USD cost of prompt-cache traffic, which `input_tokens` does not include. */
export function estimateCacheCostUsd(model: string | null | undefined, readTokens: number, writeTokens: number): number {
    const p = pricingFor(model);
    if (!p) return 0;
    const readPrice = p.cache_read_per_mtok ?? p.input_per_mtok * CACHE_READ_MULTIPLIER;
    return (readTokens * readPrice + writeTokens * p.input_per_mtok * CACHE_WRITE_MULTIPLIER) / 1_000_000;
}
