export interface ChartConfig {
    type: 'line' | 'bar';
    labels: string[];
    data: number[];
    title: string;
    yAxisLabel?: string;
}

/**
 * Generate a chart image URL via QuickChart.io.
 * Uses POST to avoid URL length limits with large datasets.
 * Returns a short URL pointing to the rendered PNG.
 */
export async function generateChartUrl(config: ChartConfig): Promise<string> {
    const chartJsConfig = {
        type: config.type,
        data: {
            labels: config.labels,
            datasets: [{
                label: config.title,
                data: config.data,
                borderColor: '#4A90D9',
                backgroundColor: config.type === 'bar' ? 'rgba(74,144,217,0.5)' : 'rgba(74,144,217,0.1)',
                fill: config.type === 'line',
                tension: 0.3,
                borderWidth: 2,
                pointRadius: 3,
            }]
        },
        options: {
            plugins: {
                title: { display: true, text: config.title, font: { size: 16 } },
                legend: { display: false },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ...(config.yAxisLabel ? { title: { display: true, text: config.yAxisLabel } } : {}),
                },
                x: {
                    ticks: { maxRotation: 45 },
                },
            },
        },
    };

    const response = await fetch('https://quickchart.io/chart/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
