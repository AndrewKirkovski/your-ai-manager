import {Tool} from './tool.types';
import {getTokenUsageStats, type TokenUsageScope} from './userStore';
import {DateTime} from 'luxon';

const TZ = 'Europe/Warsaw';

function periodRange(period: string): { from: Date; to: Date; label: string } {
    const now = DateTime.now().setZone(TZ);
    switch (period) {
        case 'today':
            return {from: now.startOf('day').toJSDate(), to: now.endOf('day').toJSDate(), label: 'today'};
        case 'week':
            return {from: now.minus({days: 7}).startOf('day').toJSDate(), to: now.endOf('day').toJSDate(), label: 'last 7 days'};
        case 'month':
            return {from: now.minus({days: 30}).startOf('day').toJSDate(), to: now.endOf('day').toJSDate(), label: 'last 30 days'};
        case 'all':
            return {from: new Date('2024-01-01T00:00:00Z'), to: now.endOf('day').toJSDate(), label: 'all time'};
        default:
            throw new Error(`Unknown period: ${period}`);
    }
}

export const GetTokenUsage: Tool = {
    name: 'GetTokenUsage',
    description:
        "Aggregate AI token usage and estimated USD cost from stat_entries. Useful when the user asks " +
        "'how many tokens did I burn today / this week' or 'how much did that cost'. " +
        "Supports scope=me|global, period=today|week|month|all, and an optional model filter. " +
        "Returns input/output/total tokens, USD cost, request count, breakdown by purpose " +
        "(e.g. 'reply', 'sticker_picker', 'vision_sticker', 'suggest_expressions'), breakdown by model " +
        "(with a `priced` flag — false means we don't have a price for that model so cost contribution is 0), " +
        "and (for week/month/all) a per-day series. " +
        "For visualizations, use GenerateStatChart({name:'ai_tokens_in', period:'week'}) or 'ai_tokens_out'.",
    parameters: {
        type: 'object',
        properties: {
            scope: {
                type: 'string',
                enum: ['me', 'global'],
                description: "'me' = just this user (default). 'global' = total across all users (Vision analyses, sticker pickers, and replies — all flows are user-attributed; user_id=0 holds the denormalized global aggregate row).",
            },
            period: {
                type: 'string',
                enum: ['today', 'week', 'month', 'all'],
                description: "Time window. Default 'today'. 'week' = last 7 days, 'month' = last 30 days, 'all' = since the bot started recording.",
            },
            model: {
                type: 'string',
                description: "Optional model id filter (e.g. 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001'). When set, restricts the aggregation to rows recorded with that exact model id. Omit to include all models.",
            },
        },
    },
    execute: async (args: {userId: number; scope?: string; period?: string; model?: string}) => {
        const scope: TokenUsageScope = args.scope === 'global' ? 'global' : 'me';
        const period = args.period ?? 'today';
        let range: { from: Date; to: Date; label: string };
        try {
            range = periodRange(period);
        } catch (err) {
            return {success: false, message: err instanceof Error ? err.message : String(err)};
        }
        // Trim+empty-coerce so an AI calling with `model: ""` doesn't filter on the empty string.
        const modelFilter = typeof args.model === 'string' && args.model.trim() ? args.model.trim() : undefined;
        const report = getTokenUsageStats({
            scope,
            userId: scope === 'me' ? args.userId : undefined,
            from: range.from,
            to: range.to,
            model: modelFilter,
        });
        return {
            success: true,
            scope,
            period,
            period_label: range.label,
            model_filter: report.model_filter,
            input_tokens: report.input_tokens,
            output_tokens: report.output_tokens,
            total_tokens: report.total_tokens,
            cost_usd: Number(report.cost_usd.toFixed(4)),
            request_count: report.request_count,
            by_purpose: report.by_purpose,
            by_model: report.by_model,
            // by_day only useful for multi-day periods
            ...(period === 'today' ? {} : {by_day: report.by_day}),
        };
    },
};
