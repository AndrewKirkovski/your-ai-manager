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
 * Generate a chart image URL via QuickChart.io.
 * Uses Chart.js v4 time scale for proper date spacing.
 */
export async function generateChartUrl(config: ChartConfig): Promise<string> {
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
                        unit: config.timeUnit || 'day',
                        displayFormats: {
                            day: 'MMM D',
                            week: 'MMM D',
                            month: 'MMM YYYY',
                        },
                    },
                    ticks: { maxRotation: 45 },
                },
                y: {
                    beginAtZero: config.yMin == null,
                    ...(config.yMin != null ? { min: config.yMin } : {}),
                    ...(config.yMax != null ? { max: config.yMax } : {}),
                    ...(config.yAxisLabel ? { title: { display: true, text: config.yAxisLabel } } : {}),
                },
            },
        },
    };

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
