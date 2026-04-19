import {Tool} from "./tool.types";
import {
    addStatEntry,
    addStatEntriesBatch,
    getStatEntries,
    getStatEntryById,
    getTrackedStatNames,
    getLatestStat,
    getStatCount,
    updateStatEntry,
    deleteStatEntriesByIds,
    deleteStatEntriesRange,
} from "./userStore";
import {generateChartUrl} from "./chartService";
import {textify} from "./telegramFormat";
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

type TrackStatEntry = { name: string; value: number; unit?: string; note?: string; timestamp?: string };

export const TrackStat: Tool = {
    name: 'TrackStat',
    description: 'Record one or many stat/metric entries. For a single entry pass name/value at the top level. For a batch (e.g. logging a day of meals at once) pass an "entries" array — one DB insert per item, all in one transaction.',
    parameters: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Stat name in lowercase (e.g., "calories", "water", "mood", "steps", "sleep_hours", "weight"). Required unless using "entries".'
            },
            value: {
                type: 'number',
                description: 'The numeric value to record. Required unless using "entries".'
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
            },
            entries: {
                type: 'array',
                description: 'Batch mode: record multiple entries at once. When provided, top-level name/value are ignored. Each item has its own name/value/unit/note/timestamp.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        value: { type: 'number' },
                        unit: { type: 'string' },
                        note: { type: 'string' },
                        timestamp: { type: 'string', format: 'date-time' },
                    },
                    required: ['name', 'value'],
                }
            }
        }
    },
    execute: async (args: { userId: number; name?: string; value?: number; unit?: string; note?: string; timestamp?: string; entries?: TrackStatEntry[] }) => {
        if (args.entries && args.entries.length > 0) {
            const normalized = args.entries.map(e => ({
                name: textify(e.name),
                value: e.value,
                unit: textify(e.unit),
                note: textify(e.note),
                timestamp: e.timestamp ? new Date(e.timestamp) : undefined,
            }));
            const inserted = await addStatEntriesBatch(args.userId, normalized);
            return {
                success: true,
                count: inserted.length,
                recorded: normalized.map((e, i) => ({
                    id: inserted[i].id,
                    name: e.name.toLowerCase(),
                    value: e.value,
                    unit: e.unit,
                    note: e.note,
                    timestamp: inserted[i].timestamp,
                })),
                message: `Recorded ${inserted.length} stat entries`,
            };
        }

        if (!args.name || args.value === undefined || args.value === null) {
            return { success: false, message: 'TrackStat requires either "entries" array or top-level name+value.' };
        }

        const name = textify(args.name);
        const unit = textify(args.unit);
        const note = textify(args.note);
        const ts = args.timestamp ? new Date(args.timestamp) : undefined;
        const id = await addStatEntry(args.userId, name, args.value, unit, note, ts);

        return {
            success: true,
            recorded: {
                id,
                name: name.toLowerCase(),
                value: args.value,
                unit: unit,
                note: note,
                timestamp: (ts ?? new Date()).toISOString(),
            },
            message: `Recorded ${name}: ${args.value}${unit ? ' ' + unit : ''}`
        };
    }
};

export const GetStatHistory: Tool = {
    name: 'GetStatHistory',
    description: 'Get historical data for a tracked stat. Returns entries and summary (avg, min, max, total) for a time period. Entries include their numeric "id" which can be passed to UpdateStatEntry / DeleteStatEntry.',
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
            },
            limit: {
                type: 'number',
                description: 'Max entries returned (summary always covers the full range). Defaults to 200. Increase only when the user is editing/deleting specific rows and needs more IDs visible.'
            }
        },
        required: ['name']
    },
    execute: async (args: { userId: number; name: string; period?: string; from?: string; to?: string; limit?: number }) => {
        const name = textify(args.name);
        const period = args.period || 'week';
        const { from, to } = getPeriodRange(period, args.from, args.to);
        const entries = await getStatEntries(args.userId, name, from, to);

        if (entries.length === 0) {
            return { success: true, entries: [], count: 0, message: `No "${name}" entries found for period "${period}".` };
        }

        const values = entries.map(e => e.value);
        const total = values.reduce((a, b) => a + b, 0);

        const limit = args.limit && args.limit > 0 ? Math.floor(args.limit) : 200;
        const shown = entries.slice(0, limit);

        return {
            success: true,
            stat: name.toLowerCase(),
            period,
            count: entries.length,
            shown: shown.length,
            truncated: entries.length > shown.length,
            summary: {
                total: Math.round(total * 100) / 100,
                average: Math.round((total / values.length) * 100) / 100,
                min: Math.min(...values),
                max: Math.max(...values),
            },
            unit: entries[0].unit,
            entries: shown.map(e => ({
                id: e.id,
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

export const GetStatEntry: Tool = {
    name: 'GetStatEntry',
    description: 'Fetch a single stat entry by its numeric ID. Use before UpdateStatEntry or DeleteStatEntry when you need to confirm the current value.',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'number', description: 'Numeric stat entry ID' },
        },
        required: ['id'],
    },
    execute: async (args: { userId: number; id: number }) => {
        const entry = await getStatEntryById(args.userId, args.id);
        if (!entry) return { success: false, message: `Stat entry ${args.id} not found.` };
        return {
            success: true,
            entry: {
                id: entry.id,
                name: entry.name,
                value: entry.value,
                unit: entry.unit,
                note: entry.note,
                timestamp: entry.timestamp.toISOString(),
            },
        };
    },
};

type UpdateStatPatch = { name?: string; value?: number; unit?: string; note?: string; timestamp?: string };

async function applyStatPatch(userId: number, id: number, patch: UpdateStatPatch): Promise<boolean> {
    // Empty string clears unit/note. Empty string is not valid for name (ignored).
    const name = patch.name !== undefined && patch.name !== '' ? textify(patch.name) : undefined;
    const unit = patch.unit === '' ? null : textify(patch.unit);
    const note = patch.note === '' ? null : textify(patch.note);
    return updateStatEntry(userId, id, {
        name,
        value: patch.value,
        unit,
        note,
        timestamp: patch.timestamp ? new Date(patch.timestamp) : undefined,
    });
}

export const UpdateStatEntry: Tool = {
    name: 'UpdateStatEntry',
    description: 'Edit existing stat entries. Three modes: (1) single — pass "id" plus fields to change; (2) bulk same-patch — pass "ids" array plus fields to apply the same change to all; (3) bulk heterogeneous — pass "updates" array where each item has its own id and fields. Omit a field to leave it unchanged. Pass unit or note as "" (empty string) to clear it.',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'number', description: 'Single entry id (mode 1).' },
            ids: { type: 'array', description: 'Multiple entry ids for bulk same-patch (mode 2).', items: { type: 'number' } },
            updates: {
                type: 'array',
                description: 'Bulk heterogeneous updates (mode 3). Each item = {id, name?, value?, unit?, note?, timestamp?}.',
                items: {
                    type: 'object',
                    properties: {
                        id: { type: 'number' },
                        name: { type: 'string' },
                        value: { type: 'number' },
                        unit: { type: 'string' },
                        note: { type: 'string' },
                        timestamp: { type: 'string', format: 'date-time' },
                    },
                    required: ['id'],
                },
            },
            name: { type: 'string', description: 'New stat name (mode 1/2).' },
            value: { type: 'number', description: 'New value (mode 1/2).' },
            unit: { type: 'string', description: 'New unit (mode 1/2). Pass "" to clear.' },
            note: { type: 'string', description: 'New note (mode 1/2). Pass "" to clear.' },
            timestamp: { type: 'string', description: 'New timestamp ISO (mode 1/2).', format: 'date-time' },
        },
    },
    execute: async (args: {
        userId: number;
        id?: number;
        ids?: number[];
        updates?: Array<UpdateStatPatch & { id?: number }>;
        name?: string;
        value?: number;
        unit?: string;
        note?: string;
        timestamp?: string;
    }) => {
        if (args.updates && args.updates.length > 0) {
            const results: Array<{ id: number; updated: boolean }> = [];
            for (const u of args.updates) {
                if (u.id === undefined) continue;
                const { id, ...patch } = u;
                const ok = await applyStatPatch(args.userId, id, patch);
                results.push({ id, updated: ok });
            }
            const updatedCount = results.filter(r => r.updated).length;
            return { success: true, mode: 'heterogeneous', updatedCount, total: results.length, results };
        }

        const topPatch: UpdateStatPatch = {
            name: args.name,
            value: args.value,
            unit: args.unit,
            note: args.note,
            timestamp: args.timestamp,
        };
        const hasAnyField = Object.values(topPatch).some(v => v !== undefined);
        if (!hasAnyField) {
            return { success: false, message: 'UpdateStatEntry: no fields to update. Provide name/value/unit/note/timestamp, or use "updates".' };
        }

        const ids = args.ids && args.ids.length > 0 ? args.ids : (args.id !== undefined ? [args.id] : []);
        if (ids.length === 0) {
            return { success: false, message: 'UpdateStatEntry: provide "id", "ids", or "updates".' };
        }

        const results: Array<{ id: number; updated: boolean }> = [];
        for (const id of ids) {
            const ok = await applyStatPatch(args.userId, id, topPatch);
            results.push({ id, updated: ok });
        }
        const updatedCount = results.filter(r => r.updated).length;
        return {
            success: true,
            mode: ids.length === 1 ? 'single' : 'bulk_same_patch',
            updatedCount,
            total: results.length,
            results,
        };
    },
};

export const DeleteStatEntry: Tool = {
    name: 'DeleteStatEntry',
    description: 'Delete stat entries. Three modes: (1) single — pass "id"; (2) bulk by id list — pass "ids" array; (3) range — pass "name" plus a period or from/to date range to delete all entries of that stat in the window. Range mode is destructive across many rows: only use after the user clearly confirms. When period="all" (wipe entire history for a stat) you MUST also pass confirm=true — the tool will refuse otherwise.',
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'number', description: 'Single entry id.' },
            ids: { type: 'array', description: 'Multiple entry ids.', items: { type: 'number' } },
            name: { type: 'string', description: 'Stat name for range mode (required with period/from).' },
            period: {
                type: 'string',
                description: 'Predefined range for range mode.',
                enum: ['today', 'week', 'month', '3months', 'year', 'custom', 'all'],
            },
            from: { type: 'string', description: 'Start date ISO (range mode, period="custom").' },
            to: { type: 'string', description: 'End date ISO (range mode, period="custom"). Defaults to today.' },
            confirm: { type: 'boolean', description: 'Required when period="all". Set to true only after the user has unambiguously asked to wipe the stat history.' },
        },
    },
    execute: async (args: {
        userId: number;
        id?: number;
        ids?: number[];
        name?: string;
        period?: string;
        from?: string;
        to?: string;
        confirm?: boolean;
    }) => {
        if (args.id !== undefined || (args.ids && args.ids.length > 0)) {
            const ids = args.ids && args.ids.length > 0 ? args.ids : [args.id as number];
            const deleted = await deleteStatEntriesByIds(args.userId, ids);
            return {
                success: true,
                mode: ids.length === 1 ? 'single' : 'bulk_ids',
                deletedCount: deleted,
                requested: ids.length,
            };
        }

        if (args.name && (args.period || args.from)) {
            const name = textify(args.name);
            if (args.period === 'all' && !args.confirm) {
                return {
                    success: false,
                    message: `DeleteStatEntry: period="all" wipes every "${name}" entry ever recorded. Refusing without confirm=true. Ask the user to confirm explicitly, then retry with confirm=true.`,
                };
            }
            const { from, to } = getPeriodRange(args.period || 'custom', args.from, args.to);
            const deleted = await deleteStatEntriesRange(args.userId, name, from, to);
            return {
                success: true,
                mode: 'range',
                name: name.toLowerCase(),
                from: from.toISOString(),
                to: to.toISOString(),
                deletedCount: deleted,
            };
        }

        return { success: false, message: 'DeleteStatEntry: provide "id", "ids", or "name"+period/from/to.' };
    },
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

        const name = textify(args.name);
        const period = args.period || 'all';
        const chartType = (args.chart_type || 'line') as 'line' | 'bar';
        const { from, to } = getPeriodRange(period, args.from, args.to);
        const entries = await getStatEntries(args.userId, name, from, to);

        if (entries.length === 0) {
            const rangeDesc = period === 'custom' ? `${args.from} — ${args.to || 'now'}` : period;
            return { success: false, message: `No "${name}" data found for ${rangeDesc}.` };
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
        const title = `${name}${unit ? ` (${unit})` : ''}${bucketLabel} — ${period}`;

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
