import {DateTime} from 'luxon';

export interface ChartConfig {
    type: 'line' | 'bar';
    data: { x: string; y: number }[];
    title: string;
    yAxisLabel?: string;
    timeUnit?: 'day' | 'week' | 'month';
    yMin?: number;
    yMax?: number;
}

/**
 * Pick a luxon date format that drops redundant year/month when all points share them.
 * Luxon tokens: d=day, MMM=month abbr, yyyy=year.
 */
function smartDateFormat(dates: DateTime[], unit: 'day' | 'week' | 'month'): string {
    if (dates.length === 0) {
        return unit === 'month' ? 'MMM yyyy' : 'MMM d';
    }
    const years = new Set(dates.map(d => d.year));
    const months = new Set(dates.map(d => `${d.year}-${d.month}`));
    const sameYear = years.size === 1;
    const sameMonth = months.size === 1;

    if (unit === 'month') {
        return sameYear ? 'MMM' : 'MMM yyyy';
    }
    if (sameMonth) return 'd';
    if (sameYear) return 'MMM d';
    return 'MMM d, yyyy';
}

/**
 * Generate a chart image URL via QuickChart.io.
 * Uses Chart.js v4 time scale for proper date spacing.
 */
export async function generateChartUrl(config: ChartConfig): Promise<string> {
    const unit = config.timeUnit || 'day';
    const parsedDates = config.data
        .map(d => DateTime.fromISO(d.x))
        .filter(d => d.isValid);
    const dateFormat = smartDateFormat(parsedDates, unit);

    let yMin = config.yMin;
    let yMax = config.yMax;
    if (yMin == null || yMax == null) {
        const values = config.data.map(d => d.y).filter(v => typeof v === 'number' && isFinite(v));
        if (values.length > 0) {
            const vmin = Math.min(...values);
            const vmax = Math.max(...values);
            const range = vmax - vmin;
            const pad = range === 0 ? (Math.abs(vmin) * 0.1 || 1) : range * 0.1;
            if (yMin == null) yMin = vmin - pad;
            if (yMax == null) yMax = vmax + pad;
        }
    }

    const chartJsConfig = {
        type: config.type,
        data: {
            datasets: [{
                label: config.title,
                data: config.data,
                borderColor: '#4A90D9',
                backgroundColor: config.type === 'bar' ? 'rgba(74,144,217,0.5)' : 'rgba(74,144,217,0.1)',
                fill: config.type === 'line',
                tension: 0.3,
                borderWidth: 2,
                pointRadius: 3,
                spanGaps: true,
            }]
        },
        options: {
            plugins: {
                title: { display: true, text: config.title, font: { size: 16 } },
                legend: { display: false },
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit,
                        tooltipFormat: dateFormat,
                        displayFormats: {
                            day: dateFormat,
                            week: dateFormat,
                            month: dateFormat,
                        },
                    },
                    ticks: { maxRotation: 45 },
                },
                y: {
                    beginAtZero: false,
                    ...(yMin != null ? { min: yMin } : {}),
                    ...(yMax != null ? { max: yMax } : {}),
                    ...(config.yAxisLabel ? { title: { display: true, text: config.yAxisLabel } } : {}),
                },
            },
        },
    };

    // 15s budget — QuickChart usually responds in under 2s; cap so a wedged endpoint
    // doesn't stall the AI tool call (and therefore the user's whole turn).
    const response = await fetch('https://quickchart.io/chart/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            version: '4',
            chart: chartJsConfig,
            width: 600,
            height: 400,
            backgroundColor: 'white',
            format: 'png',
        }),
        signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
        throw new Error(`QuickChart API error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json() as { success: boolean; url: string };
    if (!result.success || !result.url) {
        throw new Error('QuickChart API returned unsuccessful response');
    }

    return result.url;
}
