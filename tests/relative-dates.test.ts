import test from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeRelativeDates, repairCompactedRow } from '../dateUtils.ts';

test('plain relative words become phrases that stay true', () => {
    assert.equal(neutralizeRelativeDates('сегодня созвон'), 'в тот день созвон');
    assert.equal(neutralizeRelativeDates('позвонил вчера'), 'позвонил накануне');
    assert.equal(neutralizeRelativeDates('созвон завтра'), 'созвон на следующий день');
    assert.equal(neutralizeRelativeDates('сегодня же сделал'), 'в тот же день сделал');
});

test('prepositions take their own forms', () => {
    const table: [string, string, string, string][] = [
        ['на', 'на тот день', 'на следующий день', 'на предыдущий день'],
        ['за', 'за тот день', 'за следующий день', 'за предыдущий день'],
        ['до', 'до того дня', 'до следующего дня', 'до предыдущего дня'],
        ['с', 'с того дня', 'со следующего дня', 'с предыдущего дня'],
        ['со', 'с того дня', 'со следующего дня', 'с предыдущего дня'],
        ['к', 'к тому дню', 'к следующему дню', 'к предыдущему дню'],
    ];
    for (const [prep, today, tomorrow, yesterday] of table) {
        assert.equal(neutralizeRelativeDates(`${prep} сегодня`), today);
        assert.equal(neutralizeRelativeDates(`${prep} завтра`), tomorrow);
        assert.equal(neutralizeRelativeDates(`${prep} вчера`), yesterday);
    }
});

test('other prepositions stay unchanged and are reported', () => {
    const kept: string[] = [];
    assert.equal(neutralizeRelativeDates('задачи для сегодня и после завтра', k => kept.push(k)), 'задачи для сегодня и после завтра');
    assert.deepEqual(kept, ['для сегодня', 'после завтра']);
});

test('longer words that contain a relative word are left alone', () => {
    for (const word of ['сегодняшний', 'завтрак', 'послезавтра', 'позавчера', 'вчерашний', 'сегодня-завтра']) {
        assert.equal(neutralizeRelativeDates(word), word);
    }
});

test('case is kept', () => {
    assert.equal(neutralizeRelativeDates('Сегодня созвон'), 'В тот день созвон');
    assert.equal(neutralizeRelativeDates('СЕГОДНЯ созвон'), 'В ТОТ ДЕНЬ созвон');
    assert.equal(neutralizeRelativeDates('На завтра'), 'На следующий день');
});

test('markdown around a word does not stop the rewrite', () => {
    assert.equal(neutralizeRelativeDates('**сегодня** в 20:01'), '**в тот день** в 20:01');
});

test('quotes, code, tags, links and tool lines stay as written and are reported', () => {
    const spans = [
        '«сегодня»',
        '"сегодня"',
        '„сегодня“',
        '`сегодня`',
        '<tag сегодня>',
        'https://example.com/сегодня',
    ];
    for (const span of spans) {
        const kept: string[] = [];
        assert.equal(neutralizeRelativeDates(`до ${span} после`, k => kept.push(k)), `до ${span} после`);
        assert.deepEqual(kept, [span]);
    }
    const toolLines = '[Tool: X]\nInput: {"note":"сегодня"}\nOutput: сегодня\nError: сегодня\nBlocked: сегодня';
    assert.equal(neutralizeRelativeDates(toolLines), toolLines);
});

test('a second run changes nothing', () => {
    const once = neutralizeRelativeDates('Сегодня созвон, на завтра план, вчера звонил, с сегодня начнём');
    assert.equal(neutralizeRelativeDates(once), once);
});

test('a stored summary keeps its wrapper byte for byte', () => {
    const wrapper = '<system>Compacted summary of 2 bot messages from 04 апреля в 11:14 — сегодня в 17:00</system>\n';
    assert.equal(repairCompactedRow(`${wrapper}Сегодня в 17:00 снова`), `${wrapper}В тот день в 17:00 снова`);
});

test('rows that are not summaries are refused', () => {
    assert.equal(repairCompactedRow('сегодня обычный ответ'), null);
    assert.equal(repairCompactedRow('<system>Compacted summary of 2 bot messages from x'), null);
    assert.equal(repairCompactedRow('<system>Other</system>\nсегодня'), null);
});
