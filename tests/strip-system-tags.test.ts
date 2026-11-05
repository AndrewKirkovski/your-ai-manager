import test from 'node:test';
import assert from 'node:assert/strict';
import { stripSystemTags } from '../telegramFormat.ts';

test('system tags go, with their contents', () => {
    assert.equal(stripSystemTags('ok <system>x</system> y'), 'ok  y');
    assert.equal(stripSystemTags('<SYSTEM>x</SYSTEM>y'), 'y');
    assert.equal(stripSystemTags('<system foo="bar">x</system>y'), 'y');
    assert.equal(stripSystemTags('a </system> b'), 'a  b');
});

test('text with no system tag comes back exactly as written', () => {
    for (const text of ['если a<b то c', 'лампы <E27 и дальше', 'R&D: 5 < 6', '<3 люблю', 'x<y>z', '']) {
        assert.equal(stripSystemTags(text), text);
    }
});
