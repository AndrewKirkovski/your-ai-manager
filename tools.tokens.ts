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
        "Aggregate AI token usage from stat_entries. Useful when the user asks 'how many tokens did I burn today / this week', " +
        "or for self-reflection on cost. Supports scope=me|global|system and period=today|week|month|all. " +
        "Returns input/output/total token counts, request count, per-purpose breakdown (e.g. 'reply', 'sticker_picker', 'vision_sticker', 'suggest_expressions'), " +
        "and (for week/month/all) per-day series. " +
        "For visualizations, use GenerateStatChart({name:'ai_tokens_in', period:'week'}) or 'ai_tokens_out'.",
    parameters: {
        type: 'object',
        properties: {
            scope: {
                type: 'string',
                enum: ['me', 'global', 'system'],
                description: "'me' = just this user (default). 'global' = all users summed. 'system' = only background system calls (sticker picker, Vision analyses, etc; user_id=0).",
            },
            period: {
                type: 'string',
                enum: ['today', 'week', 'month', 'all'],
                description: "Time window. Default 'today'. 'week' = last 7 days, 'month' = last 30 days, 'all' = since the bot started recording.",
            },
        },
    },
    execute: async (args: {userId: number; scope?: string; period?: string}) => {
        const scope: TokenUsageScope = (args.scope === 'global' || args.scope === 'system') ? args.scope : 'me';
        const period = args.period ?? 'today';
        let range: { from: Date; to: Date; label: string };
        try {
            range = periodRange(period);
        } catch (err) {
            return {success: false, message: err instanceof Error ? err.message : String(err)};
        }
        const report = getTokenUsageStats({
            scope,
            userId: scope === 'me' ? args.userId : undefined,
            from: range.from,
            to: range.to,
        });
        return {
            success: true,
            scope,
            period,
            period_label: range.label,
            input_tokens: report.input_tokens,
            output_tokens: report.output_tokens,
            total_tokens: report.total_tokens,
            request_count: report.request_count,
            by_purpose: report.by_purpose,
            // by_day only useful for multi-day periods
            ...(period === 'today' ? {} : {by_day: report.by_day}),
        };
    },
};
