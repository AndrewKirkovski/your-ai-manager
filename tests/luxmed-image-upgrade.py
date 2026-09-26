"""Rehearse Watchtower updates using the deployed Compose environment and PG10.

Only disposable containers/volumes created with this run's unique prefix are
removed. No Telegram or LuxMed credentials or external API calls are used.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import time
import urllib.request


PREFIX = 'luxmed-upgrade-' + secrets.token_hex(4)
NETWORK = PREFIX
DB = PREFIX + '-db'
SIDECAR = PREFIX + '-sidecar'
VOLUME = PREFIX + '-postgres'
TAG = PREFIX + ':sidecar'
ROOT = Path(__file__).resolve().parents[1]
ENCRYPTION_SECRET = secrets.token_hex(32)
WEBHOOK_SECRET = secrets.token_hex(32)
LEGACY_IMAGE = os.environ['LEGACY_SIDECAR_IMAGE']
NEW_IMAGE = os.environ.get('SIDECAR_TEST_IMAGE', 'luxmed-sidecar:test')
BOT_IMAGE = os.environ.get('BOT_TEST_IMAGE', 'luxmed-bot:test')


def docker(*args, check=True):
    result = subprocess.run(['docker', *args], text=True, capture_output=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if check and result.returncode:
        # Do not echo argv, which can contain fixture secrets.
        raise RuntimeError(result.stderr[-4000:])
    return result


def health():
    ports = json.loads(docker('inspect', '--format', '{{json .NetworkSettings.Ports}}', SIDECAR).stdout)
    port = ports['8080/tcp'][0]['HostPort']
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/api/v1/health', timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


def wait_health():
    for _ in range(120):
        if health():
            return
        time.sleep(2)
    logs = docker('logs', '--tail', '120', SIDECAR, check=False)
    message = (logs.stdout + logs.stderr).replace(ENCRYPTION_SECRET, '<redacted>').replace(WEBHOOK_SECRET, '<redacted>')
    raise AssertionError('Sidecar never became healthy:\n' + message)


def client(secret=None, expected_failure=False):
    env = ['-e', f'LUXMED_SIDECAR_URL=http://{SIDECAR}:8080',
           '-e', f'LUXMED_SECURITY_SECRET={ENCRYPTION_SECRET}',
           '-e', f'EXPECT_AUTH_FAILURE={str(expected_failure).lower()}']
    if secret is not None:
        env += ['-e', f'LUXMED_SIDECAR_SECRET={secret}']
    result = docker('run', '--rm', '--network', NETWORK, *env,
                    '-v', f'{ROOT / "tests"}:/app/tests:ro', BOT_IMAGE,
                    'node', '--import', 'tsx', '/app/tests/luxmed-upgrade-client.ts')
    print(result.stdout, flush=True)


try:
    docker('network', 'create', NETWORK)
    docker('volume', 'create', VOLUME)
    docker('run', '-d', '--name', DB, '--network', NETWORK, '--network-alias', 'luxmed-db',
           '-e', 'POSTGRES_USER=lbs', '-e', 'POSTGRES_PASSWORD=lsb123', '-e', 'POSTGRES_DB=lbs',
           '-v', f'{VOLUME}:/var/lib/postgresql/data', 'postgres:10.6')
    for _ in range(60):
        if docker('exec', DB, 'pg_isready', '-U', 'lbs', check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise AssertionError('Fixture PostgreSQL failed to start')

    docker('pull', LEGACY_IMAGE)
    docker('tag', LEGACY_IMAGE, TAG)
    legacy_env = ['-e', 'DB_HOST=luxmed-db', '-e', 'DB_PORT=5432', '-e', 'SERVER_PORT=8080',
                  '-e', 'TELEGRAM_ENABLED=false', '-e', f'SECURITY_SECRET={ENCRYPTION_SECRET}',
                  '-e', f'MONITORING_WEBHOOK_URL=http://bot:3000/api/luxmed/monitoring-callback?secret={WEBHOOK_SECRET}']
    docker('run', '-d', '--name', SIDECAR, '--network', NETWORK,
           '-p', '127.0.0.1::8080', *legacy_env, TAG)
    wait_health()
    # New bot may arrive first. The old sidecar must accept its extra header.
    client()
    docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-v', 'ON_ERROR_STOP=1', '-c',
           "INSERT INTO credentials (account_id, user_id, username, password) VALUES (424242,424242,'fixture-user','fixture-ciphertext');")
    old_db_id = docker('inspect', '--format', '{{.Id}}', DB).stdout.strip()
    original_env = docker('inspect', '--format', '{{json .Config.Env}}', SIDECAR).stdout

    # Exercise Watchtower itself, including CMD adoption and environment reuse.
    docker('tag', NEW_IMAGE, TAG)
    result = docker('run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock',
                    '-e', 'DOCKER_API_VERSION=1.44', 'containrrr/watchtower:1.7.1',
                    '--run-once', '--no-pull', SIDECAR)
    print(result.stdout + result.stderr, flush=True)
    expected_id = docker('image', 'inspect', '--format', '{{.Id}}', NEW_IMAGE).stdout.strip()
    assert docker('inspect', '--format', '{{.Image}}', SIDECAR).stdout.strip() == expected_id
    assert docker('inspect', '--format', '{{json .Config.Env}}', SIDECAR).stdout == original_env
    wait_health()
    client()
    client('incorrect-key', expected_failure=True)
    assert docker('inspect', '--format', '{{.Id}}', DB).stdout.strip() == old_db_id
    assert docker('exec', DB, 'cat', '/var/lib/postgresql/data/PG_VERSION').stdout.strip() == '10'
    row = docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                 "SELECT username || ':' || password FROM credentials WHERE account_id=424242").stdout.strip()
    assert row == 'fixture-user:fixture-ciphertext'
    print('Watchtower updated the sidecar with unchanged environment, PG10 volume and credentials.', flush=True)

    # Explicit new secrets override the derived legacy key on both sides.
    docker('rm', '-f', SIDECAR)
    explicit_secret = secrets.token_hex(32)
    docker('run', '-d', '--name', SIDECAR, '--network', NETWORK, '-p', '127.0.0.1::8080',
           *legacy_env, '-e', 'DB_PASSWORD=lsb123', '-e', f'REST_SECRET={explicit_secret}', NEW_IMAGE)
    wait_health()
    client(explicit_secret)
    client(expected_failure=True)
    print('Explicit REST secret overrides legacy authentication.', flush=True)
finally:
    for container in (SIDECAR, DB):
        docker('rm', '-f', container, check=False)
    docker('volume', 'rm', VOLUME, check=False)
    docker('network', 'rm', NETWORK, check=False)
