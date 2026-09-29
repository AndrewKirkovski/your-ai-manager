"""Exercise the release guard without contacting GHCR or a host."""

import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
from luxmed_release_guard import make_pin, verify, verify_pin


SHA = 'a' * 40
LOCAL = 'luxmed-bot:test'
TAG = 'registry/bot:' + SHA
LATEST = 'registry/bot:latest'
LABEL = '{{ index .Config.Labels "org.opencontainers.image.revision" }}'


class FakeDocker:
    def __init__(self, tag_id=None, latest_id='old', latest_revision='older', pull_error='manifest unknown'):
        self.tag_id = tag_id
        self.latest_id = latest_id
        self.latest_revision = latest_revision
        self.pull_error = pull_error

    def __call__(self, *args):
        if args == ('pull', TAG):
            return subprocess.CompletedProcess(args, 0 if self.tag_id is not None else 1,
                                               '', '' if self.tag_id is not None else self.pull_error)
        if args[:3] == ('image', 'inspect', '--format'):
            template, image = args[3:]
            if template == LABEL:
                value = SHA if image == LOCAL else self.latest_revision
            elif template == '{{.Id}}':
                value = {'luxmed-bot:test': 'candidate', TAG: self.tag_id,
                         LATEST: self.latest_id}[image]
            else:
                raise AssertionError(args)
            return subprocess.CompletedProcess(args, 0, str(value) + '\n', '')
        raise AssertionError(args)


class PinDocker:
    def __init__(self, image_id):
        self.image_id = image_id

    def __call__(self, *args):
        if args == ('image', 'inspect', '--format', '{{.Id}}', LOCAL):
            return subprocess.CompletedProcess(args, 0, self.image_id + '\n', '')
        raise AssertionError(args)


class ReleaseGuardTest(unittest.TestCase):
    def test_missing_tag_can_be_published(self):
        self.assertEqual(verify(LOCAL, TAG, SHA, LATEST, FakeDocker()), 'missing')

    def test_identical_tag_is_harmless_on_rerun(self):
        self.assertEqual(verify(LOCAL, TAG, SHA, LATEST,
                                FakeDocker(tag_id='candidate', latest_id='candidate', latest_revision=SHA)), 'present')

    def test_same_sha_with_different_tag_bytes_is_blocked(self):
        with self.assertRaisesRegex(RuntimeError, 'different image bytes'):
            verify(LOCAL, TAG, SHA, LATEST, FakeDocker(tag_id='changed'))

    def test_same_sha_with_different_watched_bytes_is_blocked(self):
        with self.assertRaisesRegex(RuntimeError, 'different bytes'):
            verify(LOCAL, TAG, SHA, LATEST, FakeDocker(latest_revision=SHA))

    def test_ambiguous_registry_failure_is_blocked(self):
        with self.assertRaisesRegex(RuntimeError, 'Cannot establish'):
            verify(LOCAL, TAG, SHA, LATEST, FakeDocker(pull_error='connection timed out'))

    def test_staged_pin_matches_the_exact_image_sha_and_run(self):
        image = PinDocker('sha256:' + '1' * 64)
        pin = make_pin(LOCAL, SHA, '12345', image)
        self.assertEqual(pin, {'version': 1, 'revision': SHA, 'run_id': '12345',
                               'image_id': 'sha256:' + '1' * 64})
        verify_pin(pin, LOCAL, SHA, '12345', image)

    def test_staged_pin_rejects_changed_image_or_release_identity(self):
        pin = make_pin(LOCAL, SHA, '12345', PinDocker('sha256:' + '1' * 64))
        for image, revision, run_id in [
            (PinDocker('sha256:' + '2' * 64), SHA, '12345'),
            (PinDocker('sha256:' + '1' * 64), 'b' * 40, '12345'),
            (PinDocker('sha256:' + '1' * 64), SHA, '67890'),
        ]:
            with self.subTest(revision=revision, run_id=run_id, image_id=image.image_id):
                with self.assertRaisesRegex(RuntimeError, 'differs'):
                    verify_pin(pin, LOCAL, revision, run_id, image)

    def test_staged_pin_rejects_malformed_attestation(self):
        with self.assertRaisesRegex(RuntimeError, 'malformed'):
            verify_pin({'revision': SHA}, LOCAL, SHA, '12345', PinDocker('sha256:' + '1' * 64))
        with self.assertRaisesRegex(RuntimeError, 'content digest'):
            make_pin(LOCAL, SHA, '12345', PinDocker('not-a-digest'))


if __name__ == '__main__':
    unittest.main()
