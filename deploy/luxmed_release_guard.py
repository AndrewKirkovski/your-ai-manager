"""Check watched and SHA-tagged LuxMed images before changing registry tags."""

import os
import re
import subprocess
import sys


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


if __name__ == '__main__':
    if len(sys.argv) != 5:
        raise SystemExit('Usage: luxmed_release_guard.py LOCAL SHA_TAG REVISION WATCHED_TAG')
    try:
        print(verify(*sys.argv[1:]))
    except (RuntimeError, ValueError) as error:
        print(error, file=sys.stderr)
        raise SystemExit(1) from None
