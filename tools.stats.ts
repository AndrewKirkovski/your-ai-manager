import {Tool} from "./tool.types";
import {
    addStatEntry,
    getStatEntries,
    getTrackedStatNames,
    getLatestStat,
    getStatCount,
} from "./userStore";
import {generateChartUrl} from "./chartService";
import TelegramBot from "node-telegram-bot-api";
import {DateTime} from 'luxon';

// Bot instance reference — set via initStatTools()
let botInstance: TelegramBot | null = null;

export function initStatTools(bot: TelegramBot): void {
    botInstance = bot;
}

const TZ = 'Europe/Warsaw';

function getPeriodRange(period: string, customFrom?: string, customTo?: string): { from: Date; to: Date } {
    const now = DateTime.now().setZone(TZ);

    if (period === 'custom' && customFrom) {
        const fromDt = DateTime.fromISO(customFrom, { zone: TZ });
        if (!fromDt.isValid) throw new Error(`Invalid "from" date: ${customFrom}`);
        const from = fromDt.startOf('day').toJSDate();

        let to = now.toJSDate();
        if (customTo) {
            const toDt = DateTime.fromISO(customTo, { zone: TZ });
            if (!toDt.isValid) throw new Error(`Invalid "to" date: ${customTo}`);
            to = toDt.endOf('day').toJSDate();
        }
        return { from, to };
    }

    const to = now.endOf('day').toJSDate();
    let from: Date;

    switch (period) {
        case 'today':
            from = now.startOf('day').toJSDate();
            break;
        case 'week':
            from = now.minus({ weeks: 1 }).toJSDate();
            break;
        case 'month':
            from = now.minus({ months: 1 }).toJSDate();
            break;
        case '3months':
            from = now.minus({ months: 3 }).toJSDate();
            break;
        case 'year':
            from = now.minus({ years: 1 }).toJSDate();
            break;
        default:
            from = new Date('2000-01-01');
            break;
    }

    return { from, to };
}

/** Bucket a DateTime to the start of its period (day/week/month). */
function toBucketKey(dt: DateTime, unit: 'day' | 'week' | 'month'): string {
    return dt.startOf(unit).toISODate()!;
}

export const TrackStat: Tool = {
    name: 'TrackStat',
    description: 'Record a daily stat/metric for the user. Use for tracking calories, water intake, mood, steps, sleep hours, weight, or any numeric measurement the user mentions.',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Stat name in lowercase (e.g., "calories", "water", "mood", "steps", "sleep_hours", "weight")'
            },
            value: {
                type: 'number',
                description: 'The numeric value to record'
            },
            unit: {
                type: 'string',
                description: 'Unit of measurement (e.g., "kcal", "ml", "hours", "kg", "1-10")'
            },
            note: {
                type: 'string',
                description: 'Optional context note (e.g., "after lunch", "morning run")'
            },
            timestamp: {
                type: 'string',
                description: 'When this measurement was taken (ISO format). Defaults to now.',
                format: 'date-time'
            }
        },
        required: ['name', 'value']
    },
    execute: async (args: { userId: number; name: string; value: number; unit?: string; note?: string; timestamp?: string }) => {
        const ts = args.timestamp ? new Date(args.timestamp) : undefined;
        await addStatEntry(args.userId, args.name, args.value, args.unit, args.note, ts);

        return {
            success: true,
            recorded: {
                name: args.name.toLowerCase(),
                value: args.value,
                unit: args.unit,
                note: args.note,
                timestamp: (ts ?? new Date()).toISOString(),
            },
            message: `Recorded ${args.name}: ${args.value}${args.unit ? ' ' + args.unit : ''}`
        };
    }
};

export const GetStatHistory: Tool = {
    name: 'GetStatHistory',
    description: 'Get historical data for a tracked stat. Returns entries and summary (avg, min, max, total) for a time period.',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Stat name to query (e.g., "calories", "water", "mood")'
            },
            period: {
                type: 'string',
                description: 'Time period: "today", "week", "month", "year", "custom", "all". Defaults to "week". Use "custom" with from/to.',
                enum: ['today', 'week', 'month', '3months', 'year', 'custom', 'all']
            },
            from: {
                type: 'string',
                description: 'Start date for custom range (ISO date, e.g. "2026-03-01"). Only used when period="custom".'
            },
            to: {
                type: 'string',
                description: 'End date for custom range (ISO date). Defaults to today. Only used when period="custom".'
            }
        },
        required: ['name']
    },
    execute: async (args: { userId: number; name: string; period?: string; from?: string; to?: string }) => {
        const period = args.period || 'week';
        const { from, to } = getPeriodRange(period, args.from, args.to);
        const entries = await getStatEntries(args.userId, args.name, from, to);

        if (entries.length === 0) {
            return { success: true, entries: [], count: 0, message: `No "${args.name}" entries found for period "${period}".` };
        }

        const values = entries.map(e => e.value);
        const total = values.reduce((a, b) => a + b, 0);

        return {
            success: true,
            stat: args.name.toLowerCase(),
            period,
            count: entries.length,
            summary: {
                total: Math.round(total * 100) / 100,
                average: Math.round((total / values.length) * 100) / 100,
                min: Math.min(...values),
                max: Math.max(...values),
            },
            unit: entries[0].unit,
            entries: entries.slice(0, 20).map(e => ({
                value: e.value,
                note: e.note,
                timestamp: e.timestamp.toISOString(),
            })),
        };
    }
};

export const ListTrackedStats: Tool = {
    name: 'ListTrackedStats',
    description: 'List all stat types the user has ever tracked, with their most recent values and entry counts.',
    parameters: {
        type: 'object',
        properties: {}
    },
    execute: async (args: { userId: number }) => {
        const statNames = await getTrackedStatNames(args.userId);

        if (statNames.length === 0) {
            return { success: true, stats: [], count: 0, message: 'No stats tracked yet.' };
        }

        const stats = await Promise.all(statNames.map(async (s) => {
            const latest = await getLatestStat(args.userId, s.name);
            const count = await getStatCount(args.userId, s.name);
            return {
                name: s.name,
                unit: s.unit,
                lastValue: latest?.value,
                lastRecorded: latest?.timestamp.toISOString(),
                totalEntries: count,
            };
        }));

        return { success: true, stats, count: stats.length };
    }
};

export const GenerateStatChart: Tool = {
    name: 'GenerateStatChart',
    description: 'Generate a chart image for a tracked stat and send it to the user. Use when user asks to visualize progress, see a graph, or wants a chart.',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Stat name to chart (e.g., "calories", "mood", "weight")'
            },
            period: {
                type: 'string',
                description: 'Time period for chart: "today", "week", "month", "3months", "year", "all", "custom". Defaults to "all" (full history). Use "custom" with from/to.',
                enum: ['today', 'week', 'month', '3months', 'year', 'all', 'custom']
            },
            bucket: {
                type: 'string',
                description: 'Aggregation bucket size. Defaults to "day" (one point per day). Use "week" or "month" ONLY when the user explicitly asks to group by week/month.',
                enum: ['day', 'week', 'month']
            },
            from: {
                type: 'string',
                description: 'Start date for custom range (ISO date, e.g. "2026-01-01"). Only used when period="custom".'
            },
            to: {
                type: 'string',
                description: 'End date for custom range (ISO date). Defaults to today. Only used when period="custom".'
            },
            chart_type: {
                type: 'string',
                description: 'Type of chart: "line" for trends, "bar" for daily/weekly totals.',
                enum: ['line', 'bar']
            },
            aggregation: {
                type: 'string',
                description: 'How to aggregate values within each bucket. "sum" for additive stats (calories, water, steps). "avg" for non-additive stats (mood, weight, sleep hours). Defaults to "sum" for bar charts, "avg" for line charts.',
                enum: ['sum', 'avg']
            },
            y_min: {
                type: 'number',
                description: 'Minimum Y-axis value. Omit for smart autorange (tight padding around data). Only set when you want to force a specific floor (e.g., y_min=0 to anchor at zero).'
            },
            y_max: {
                type: 'number',
                description: 'Maximum Y-axis value. Omit for smart autorange. Only set when you want to force a specific ceiling.'
            },
            force: {
                type: 'boolean',
                description: 'Bypass the too-many-points safety check. Set to true only after the first call failed with a density error and you decided rendering a dense chart is still the right choice.'
            }
        },
        required: ['name']
    },
    execute: async (args: { userId: number; name: string; period?: string; bucket?: string; from?: string; to?: string; chart_type?: string; aggregation?: string; y_min?: number; y_max?: number; force?: boolean }) => {
        if (!botInstance) {
            return { success: false, message: 'Chart generation not available (bot not initialized).' };
        }

        const period = args.period || 'all';
        const chartType = (args.chart_type || 'line') as 'line' | 'bar';
        const { from, to } = getPeriodRange(period, args.from, args.to);
        const entries = await getStatEntries(args.userId, args.name, from, to);

        if (entries.length === 0) {
            const rangeDesc = period === 'custom' ? `${args.from} — ${args.to || 'now'}` : period;
            return { success: false, message: `No "${args.name}" data found for ${rangeDesc}.` };
        }

        const bucketUnit = (args.bucket || 'day') as 'day' | 'week' | 'month';
        const bucketData = new Map<string, number[]>();
        for (const entry of entries) {
            const dt = DateTime.fromJSDate(entry.timestamp).setZone(TZ);
            const bucketKey = toBucketKey(dt, bucketUnit);
            const existing = bucketData.get(bucketKey) ?? [];
            existing.push(entry.value);
            bucketData.set(bucketKey, existing);
        }

        // Build {x, y} data points sorted by date
        const agg = args.aggregation || (chartType === 'bar' ? 'sum' : 'avg');
        const sortedBuckets = [...bucketData.keys()].sort();
        const data = sortedBuckets.map(dateStr => {
            const values = bucketData.get(dateStr)!;
            const total = values.reduce((a, b) => a + b, 0);
            const y = agg === 'avg' ? total / values.length : total;
            return { x: dateStr, y: Math.round(y * 100) / 100 };
        });

        const maxPoints = chartType === 'bar' ? 60 : 180;
        if (data.length > maxPoints && !args.force) {
            return {
                success: false,
                tooManyPoints: true,
                dataPoints: data.length,
                maxPoints,
                message: `Chart would have ${data.length} ${bucketUnit} points (limit: ${maxPoints} for ${chartType}). Options: (1) retry with a coarser bucket (e.g. bucket="week" or "month"), (2) narrow the period/date range, or (3) retry with force=true to render anyway (labels will be dense).`,
            };
        }

        const unit = entries[0].unit;
        const bucketLabel = bucketUnit !== 'day' ? ` (${bucketUnit}ly ${agg})` : '';
        const title = `${args.name}${unit ? ` (${unit})` : ''}${bucketLabel} — ${period}`;

        const chartUrl = await generateChartUrl({
            type: chartType,
            data,
            title,
            yAxisLabel: unit,
            timeUnit: bucketUnit,
            yMin: args.y_min,
            yMax: args.y_max,
        });

        try {
            await botInstance.sendPhoto(args.userId, chartUrl, {
                caption: title,
                disable_notification: true,
            });
            return { success: true, message: `Chart sent: ${title}`, dataPoints: data.length };
        } catch (error) {
            return { success: false, message: `Failed to send chart: ${error instanceof Error ? error.message : String(error)}` };
        }
    }
};
