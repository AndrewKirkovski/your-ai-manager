"""Check watched and SHA-tagged LuxMed images before changing registry tags."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path


def docker(*args):
    return subprocess.run(
        [os.environ.get('DOCKER_COMMAND', 'docker'), *args],
        capture_output=True,
        text=True,
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
    )


def inspect(image, template, call):
    result = call('image', 'inspect', '--format', template, image)
    if result.returncode:
        raise RuntimeError(f'Could not inspect the release image: {image}')
    return result.stdout.strip()


def verify(local, sha_tag, revision, watched_tag, call=docker):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Release revision must be a full lowercase SHA.')
    label = '{{ index .Config.Labels "org.opencontainers.image.revision" }}'
    local_revision = inspect(local, label, call)
    if local_revision != revision:
        raise RuntimeError('Candidate image revision does not match the release SHA.')
    local_id = inspect(local, '{{.Id}}', call)
    watched_revision = inspect(watched_tag, label, call)
    if watched_revision == revision and inspect(watched_tag, '{{.Id}}', call) != local_id:
        raise RuntimeError('The watched image already reports this SHA with different bytes.')

    pull = call('pull', sha_tag)
    if pull.returncode == 0:
        remote_id = inspect(sha_tag, '{{.Id}}', call)
        if remote_id != local_id:
            raise RuntimeError('The SHA tag already exists with different image bytes.')
        return 'present'
    error = (pull.stdout + pull.stderr).lower()
    if 'manifest unknown' in error or 'manifest not found' in error or 'unknown manifest' in error:
        return 'missing'
    raise RuntimeError('Cannot establish whether the SHA tag exists; registry publication is blocked.')


def make_pin(image, revision, run_id, call=docker):
    if not re.fullmatch(r'[0-9a-f]{40}', revision) or not re.fullmatch(r'[1-9][0-9]*', run_id):
        raise ValueError('The staged release needs a full SHA and numeric run ID.')
    image_id = inspect(image, '{{.Id}}', call)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image_id):
        raise RuntimeError('The sidecar image has no valid content digest.')
    return {'version': 1, 'revision': revision, 'run_id': run_id, 'image_id': image_id}


def verify_pin(pin, image, revision, run_id, call=docker):
    if not isinstance(pin, dict) or set(pin) != {'version', 'revision', 'run_id', 'image_id'}:
        raise RuntimeError('The staged sidecar digest record is malformed.')
    expected = make_pin(image, revision, run_id, call)
    if pin != expected:
        raise RuntimeError('The staged sidecar digest differs from the tested Stage A image.')


if __name__ == '__main__':
    try:
        if len(sys.argv) == 6 and sys.argv[1] == 'write-pin':
            _, _, image, revision, run_id, path = sys.argv
            Path(path).write_text(json.dumps(make_pin(image, revision, run_id), sort_keys=True) + '\n', encoding='utf-8')
        elif len(sys.argv) == 6 and sys.argv[1] == 'check-pin':
            _, _, image, revision, run_id, path = sys.argv
            verify_pin(json.loads(Path(path).read_text(encoding='utf-8')), image, revision, run_id)
        elif len(sys.argv) == 5:
            print(verify(*sys.argv[1:]))
        else:
            raise ValueError('Usage: luxmed_release_guard.py LOCAL SHA_TAG REVISION WATCHED_TAG | write-pin/check-pin IMAGE REVISION RUN_ID PATH')
    except (OSError, json.JSONDecodeError, RuntimeError, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from None
