import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseRevision, releaseVersionReply } from '../releaseVersion.ts';

test('release reply never claims an image revision without a full build SHA', () => {
    assert.equal(releaseRevision('1.0.0'), null);
    assert.equal(releaseRevision('71d61a0'), null);
    assert.equal(releaseVersionReply(undefined, releaseRevision('71d61a0')), 'Bot image revision is unavailable.');
});

test('release reply echoes the running image revision and a fresh operator challenge', () => {
    const sha = 'a'.repeat(40);
    assert.equal(releaseRevision(sha), sha);
    assert.equal(releaseVersionReply('release123', sha), `Running bot revision: ${sha}\nChallenge: release123`);
});
