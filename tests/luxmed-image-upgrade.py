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


PREFIX = 'luxmed-upgrade-' + secrets.token_hex(4)
NETWORK = PREFIX
DB = PREFIX + '-db'
SIDECAR = PREFIX + '-sidecar'
BOT = PREFIX + '-bot'
VOLUME = PREFIX + '-postgres'
BOT_VOLUME = PREFIX + '-sqlite'
TAG = PREFIX + ':sidecar'
BOT_TAG = PREFIX + ':bot'
ROOT = Path(__file__).resolve().parents[1]
ENCRYPTION_SECRET = secrets.token_hex(32)
WEBHOOK_SECRET = secrets.token_hex(32)
LEGACY_IMAGE = os.environ['LEGACY_SIDECAR_IMAGE']
NEW_IMAGE = os.environ.get('SIDECAR_TEST_IMAGE', 'luxmed-sidecar:test')
BOT_IMAGE = os.environ.get('BOT_TEST_IMAGE', 'luxmed-bot:test')
ORDER = os.environ.get('REHEARSAL_ORDER', 'bot-first')
if ORDER not in ('bot-first', 'sidecar-first'):
    raise ValueError('REHEARSAL_ORDER must be bot-first or sidecar-first')


def docker(*args, check=True):
    result = subprocess.run([os.environ.get('DOCKER_COMMAND', 'docker'), *args], text=True, capture_output=True,
                            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if check and result.returncode:
        # Do not echo argv, which can contain fixture secrets.
        raise RuntimeError(result.stderr[-4000:])
    return result


def health():
    # Exercise the bot's actual network path. Docker Desktop can leave its
    # host port forward stale when Watchtower replaces a container.
    probe = "fetch(process.env.HEALTH_URL,{signal:AbortSignal.timeout(2000)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"
    return docker('run', '--rm', '--network', NETWORK,
                  '-e', f'HEALTH_URL=http://{SIDECAR}:8080/api/v1/health',
                  BOT_IMAGE, 'node', '--eval', probe, check=False).returncode == 0


def wait_health():
    for _ in range(120):
        if health():
            return
        time.sleep(2)
    logs = docker('logs', '--tail', '120', SIDECAR, check=False)
    message = (logs.stdout + logs.stderr).replace(ENCRYPTION_SECRET, '<redacted>').replace(WEBHOOK_SECRET, '<redacted>')
    raise AssertionError('Sidecar never became healthy:\n' + message)


def client(secret=None, expected_failure=False, smart=False, persisted=False,
           image=BOT_IMAGE, legacy_auth_failure=False, legacy_read=False, legacy_smart=False,
           legacy_v2=False, legacy_barrier_ack=''):
    env = ['-e', f'LUXMED_SIDECAR_URL=http://{SIDECAR}:8080',
           '-e', f'LUXMED_SECURITY_SECRET={ENCRYPTION_SECRET}',
           '-e', f'EXPECT_AUTH_FAILURE={str(expected_failure).lower()}',
           '-e', f'EXPECT_SMART_CAPABILITIES={str(smart).lower()}',
           '-e', f'EXPECT_LEGACY_SMART_CAPABILITIES={str(legacy_smart).lower()}',
           '-e', f'EXPECT_LEGACY_V2_CAPABILITIES={str(legacy_v2).lower()}',
           '-e', f'EXPECT_ATTEMPT_PERSISTENCE={str(persisted).lower()}',
           '-e', f'EXPECT_LEGACY_BOT_AUTH_FAILURE={str(legacy_auth_failure).lower()}',
           '-e', f'EXPECT_LEGACY_BOT_READ={str(legacy_read).lower()}']
    env += ['-e', f'EXPECT_LEGACY_BARRIER_ACK={legacy_barrier_ack}']
    if secret is not None:
        env += ['-e', f'LUXMED_SIDECAR_SECRET={secret}']
    result = docker('run', '--rm', '--network', NETWORK, *env,
                    '-v', f'{ROOT / "tests"}:/app/tests:ro', image,
                    'node', '--import', 'tsx', '/app/tests/luxmed-upgrade-client.ts')
    print(result.stdout, flush=True)


def watchtower(*containers):
    result = docker('run', '--rm', '-v', '/var/run/docker.sock:/var/run/docker.sock',
                    '-e', f'DOCKER_API_VERSION={docker("version", "--format", "{{.Server.APIVersion}}").stdout.strip()}',
                    'containrrr/watchtower:1.7.1', '--run-once', '--no-pull', *containers)
    print(result.stdout + result.stderr, flush=True)


def replace_bot(legacy_bot, original_env, original_mounts):
    docker('tag', BOT_IMAGE, BOT_TAG)
    watchtower(BOT)
    expected_id = docker('image', 'inspect', '--format', '{{.Id}}', BOT_IMAGE).stdout.strip()
    assert docker('inspect', '--format', '{{.Image}}', BOT).stdout.strip() == expected_id
    updated_env = dict(item.split('=', 1) for item in json.loads(
        docker('inspect', '--format', '{{json .Config.Env}}', BOT).stdout))
    for key in ('DB_PATH', 'REHEARSAL_MARKER'):
        assert updated_env[key] == original_env[key], f'Bot configuration changed: {key}'
    for key in ('OPENROUTER_API_KEY', 'GOOGLE_MAPS_API_KEY',
                'GOOGLE_ROUTES_CACHE_PERMITTED', 'GOOGLE_GEOCODING_CACHE_PERMITTED'):
        assert key not in updated_env, f'Provider key was unexpectedly injected: {key}'
    updated_mounts = json.loads(docker('inspect', '--format', '{{json .Mounts}}', BOT).stdout)
    def mount_identity(mounts):
        return sorted((m['Destination'], m['Name'] if m['Type'] == 'volume' else m['Source'], m['RW'])
                      for m in mounts)
    assert mount_identity(updated_mounts) == mount_identity(original_mounts), 'Bot mounts changed during replacement'
    for _ in range(2):
        result = docker('exec', BOT, 'node', '--import', 'tsx', '/app/tests/luxmed-bot-upgrade-state.ts')
        print(result.stdout, flush=True)
    # Exercise the pinned old bot's real store on the migrated volume without
    # starting Telegram or a provider service.
    result = docker('run', '--rm', '--network', 'none', '-e', 'DB_PATH=/app/data/db.sqlite',
                    '-v', f'{BOT_VOLUME}:/app/data', '-v', f'{ROOT / "tests"}:/app/tests:ro',
                    legacy_bot, 'node', '--import', 'tsx', '/app/tests/luxmed-old-bot-reader.ts')
    print(result.stdout, flush=True)
    result = docker('exec', BOT, 'node', '--import', 'tsx', '/app/tests/luxmed-bot-upgrade-state.ts')
    print(result.stdout, flush=True)
    print('Watchtower updated the bot with unchanged SQLite volume and legacy auto-booking disabled.', flush=True)


try:
    docker('network', 'create', NETWORK)
    docker('volume', 'create', VOLUME)
    docker('volume', 'create', BOT_VOLUME)
    legacy_bot = os.environ['LEGACY_BOT_IMAGE']
    if os.environ.get('REHEARSAL_SKIP_PULL') != 'true':
        docker('pull', legacy_bot)
    docker('tag', legacy_bot, BOT_TAG)
    result = docker('run', '--rm', '--network', 'none', '-e', 'SEED_LEGACY=true',
                    '-v', f'{BOT_VOLUME}:/app/data', '-v', f'{ROOT / "tests"}:/app/tests:ro',
                    legacy_bot, 'node', '--import', 'tsx', '/app/tests/luxmed-bot-upgrade-state.ts')
    print(result.stdout, flush=True)
    # A named, inert bot container exercises the same Watchtower replacement and
    # persistent SQLite mount without starting Telegram or any live provider.
    docker('run', '-d', '--name', BOT, '--network', 'none',
           '-e', 'REHEARSAL_MARKER=fixture-only',
           '-v', f'{BOT_VOLUME}:/app/data', '-v', f'{ROOT / "tests"}:/app/tests:ro',
           BOT_TAG, 'node', '--eval', 'setInterval(() => {}, 3600000)')
    original_bot_env = dict(item.split('=', 1) for item in json.loads(
        docker('inspect', '--format', '{{json .Config.Env}}', BOT).stdout))
    original_bot_mounts = json.loads(docker('inspect', '--format', '{{json .Mounts}}', BOT).stdout)
    docker('run', '-d', '--name', DB, '--network', NETWORK, '--network-alias', 'luxmed-db',
           '-e', 'POSTGRES_USER=lbs', '-e', 'POSTGRES_PASSWORD=lsb123', '-e', 'POSTGRES_DB=lbs',
           '-v', f'{VOLUME}:/var/lib/postgresql/data', 'postgres:10.6')
    for _ in range(60):
        if docker('exec', DB, 'pg_isready', '-U', 'lbs', check=False).returncode == 0:
            break
        time.sleep(1)
    else:
        raise AssertionError('Fixture PostgreSQL failed to start')

    if os.environ.get('REHEARSAL_SKIP_PULL') != 'true':
        docker('pull', LEGACY_IMAGE)
    docker('tag', LEGACY_IMAGE, TAG)
    legacy_env = ['-e', 'DB_HOST=luxmed-db', '-e', 'DB_PORT=5432', '-e', 'SERVER_PORT=8080',
                  '-e', 'TELEGRAM_ENABLED=false', '-e', f'SECURITY_SECRET={ENCRYPTION_SECRET}',
                  '-e', f'MONITORING_WEBHOOK_URL=http://bot:3000/api/luxmed/monitoring-callback?secret={WEBHOOK_SECRET}']
    docker('run', '-d', '--name', SIDECAR, '--network', NETWORK, *legacy_env, TAG)
    wait_health()
    migrations = docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                        "SELECT COUNT(*) FILTER (WHERE filename LIKE '%13-cancellation-review.yml') || ':' || "
                        "COUNT(*) FILTER (WHERE filename LIKE '%14-booking-recovery.yml') FROM databasechangelog").stdout.strip()
    v2_baseline = migrations == '1:0'
    if os.environ.get('REHEARSAL_V2_BASELINE') == 'true' and not v2_baseline:
        raise AssertionError(f'Expected a v2 baseline, found migration counts {migrations}')
    print(f'Watched sidecar baseline: {"v2" if v2_baseline else "other"} (migration counts {migrations}).', flush=True)
    # The new bot can still read the old sidecar while waiting for capabilities.
    client(legacy_smart=os.environ.get('REHEARSAL_AUTHENTICATED_BASELINE') == 'true',
           legacy_v2=v2_baseline)
    docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-v', 'ON_ERROR_STOP=1', '-c',
           "INSERT INTO credentials (account_id, user_id, username, password) VALUES "
           "(424242,424242,'fixture-user','fixture-ciphertext'),"
           "(424249,424249,'clean-enrollment-fixture','fixture-ciphertext');")
    if os.environ.get('REHEARSAL_AUTHENTICATED_BASELINE') == 'true':
        # A v1 absent-feed confirmation must return to pending review during
        # the v2 migration on the same PostgreSQL 10 volume.
        docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-v', 'ON_ERROR_STOP=1', '-c',
               "INSERT INTO cancellation_receipt(account_id,reservation_id,start_at,state,requested_at,confirmed_at) "
               "VALUES (424246,77246,1791280800000,'confirmed',1,2);")
    if v2_baseline:
        # Old v2 persisted successes have no durable account lock. Check both
        # its reservation-only ACK and the new bot's exact ACK after migration.
        docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-v', 'ON_ERROR_STOP=1', '-c',
               "INSERT INTO legacy_booking_barrier(id,account_id,state,reservation_id,start_at,created_at) "
               "VALUES ('00000000-0000-0000-0000-000000424248',424248,'succeeded',77248,1791280800000,1);")
    old_db_id = docker('inspect', '--format', '{{.Id}}', DB).stdout.strip()
    original_env = dict(item.split('=', 1) for item in json.loads(
        docker('inspect', '--format', '{{json .Config.Env}}', SIDECAR).stdout))
    if ORDER == 'bot-first':
        replace_bot(legacy_bot, original_bot_env, original_bot_mounts)
        client(legacy_smart=os.environ.get('REHEARSAL_AUTHENTICATED_BASELINE') == 'true',
               legacy_v2=v2_baseline)

    # Exercise Watchtower itself, including CMD adoption and environment reuse.
    docker('tag', NEW_IMAGE, TAG)
    watchtower(SIDECAR)
    expected_id = docker('image', 'inspect', '--format', '{{.Id}}', NEW_IMAGE).stdout.strip()
    assert docker('inspect', '--format', '{{.Image}}', SIDECAR).stdout.strip() == expected_id
    updated_env = dict(item.split('=', 1) for item in json.loads(
        docker('inspect', '--format', '{{json .Config.Env}}', SIDECAR).stdout))
    for key in ('DB_HOST', 'DB_PORT', 'SERVER_PORT', 'TELEGRAM_ENABLED', 'SECURITY_SECRET', 'MONITORING_WEBHOOK_URL'):
        assert updated_env[key] == original_env[key], f'Configured variable changed: {key}'
    for key in ('REST_SECRET', 'DB_PASSWORD', 'DB_USER', 'DB_NAME'):
        assert key not in updated_env, f'New configuration was unexpectedly injected: {key}'
    wait_health()
    if v2_baseline:
        client(image=legacy_bot if ORDER == 'sidecar-first' else BOT_IMAGE, legacy_read=True,
               legacy_barrier_ack='v1' if ORDER == 'sidecar-first' else 'v2')
        assert docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                      'SELECT COUNT(*) FROM legacy_booking_barrier WHERE account_id=424248').stdout.strip() == '0'
    if ORDER == 'sidecar-first':
        # A release must keep the pinned old bot's LuxMed reads available while
        # Watchtower has replaced only the sidecar. Diagnostic mode records the
        # current 401; the CI gate requires a successful read before publication.
        # Neither mode makes a LuxMed booking or external provider request.
        require_seamless = os.environ.get('REHEARSAL_REQUIRE_SEAMLESS') == 'true'
        try:
            client(image=legacy_bot, legacy_auth_failure=not require_seamless,
                   legacy_read=require_seamless)
        except RuntimeError as error:
            if require_seamless:
                raise AssertionError('Sidecar-first release blocked: the pinned old bot cannot read LuxMed monitor state through the new sidecar. Do not publish watched tags.') from error
            raise
        client(smart=True)
        replace_bot(legacy_bot, original_bot_env, original_bot_mounts)
    client(smart=True)
    if os.environ.get('REHEARSAL_AUTHENTICATED_BASELINE') == 'true':
        migrated_receipt = docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                                  "SELECT r.state || ':' || COALESCE(r.confirmed_at::text,'null') || ':' || "
                                  "a.old_state || ':' || a.new_state FROM cancellation_receipt r "
                                  "JOIN cancellation_receipt_review_audit a ON a.account_id=r.account_id "
                                  "AND a.reservation_id=r.reservation_id AND a.start_at=r.start_at "
                                  "WHERE r.account_id=424246 AND r.reservation_id=77246").stdout.strip()
        assert migrated_receipt == 'pending:null:confirmed:pending', migrated_receipt
        print('PG10 migration returned the v1 cancellation receipt to pending review with audit.', flush=True)
    # New phase columns must migrate on the preserved PG10 volume. A restarted
    # process can release only work that never entered provider confirmation.
    docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-v', 'ON_ERROR_STOP=1', '-c',
           "INSERT INTO booking_attempt(id,account_id,fingerprint,state,created_at,phase,process_id) VALUES ('00000000-0000-0000-0000-000000424243',424243,'fixture','pending',1,'prepared','prior-process');"
           "INSERT INTO booking_account_lock(account_id,attempt_id) VALUES (424243,'00000000-0000-0000-0000-000000424243');"
           "INSERT INTO booking_attempt(id,account_id,fingerprint,state,created_at,phase,process_id) VALUES ('00000000-0000-0000-0000-000000424245',424245,'fixture','pending',1,'confirmation_started','prior-process');"
           "INSERT INTO booking_account_lock(account_id,attempt_id) VALUES (424245,'00000000-0000-0000-0000-000000424245');"
           "INSERT INTO booking_attempt(id,account_id,fingerprint,state,reservation_id,created_at,phase,process_id) VALUES ('00000000-0000-0000-0000-000000424247',424247,'fixture','succeeded',77247,1,'confirmation_started','prior-process');"
           "INSERT INTO booking_account_lock(account_id,attempt_id) VALUES (424247,'00000000-0000-0000-0000-000000424247');"
           "INSERT INTO legacy_booking_barrier(id,account_id,state,start_at,created_at,phase,process_id) VALUES ('00000000-0000-0000-0000-000000424244',424244,'pending',1,1,'prepared','prior-process');")
    docker('restart', SIDECAR)
    wait_health()
    recovery = docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                      "SELECT result FROM (VALUES "
                      "(1,(SELECT state || ':' || COALESCE(error_code,'') FROM booking_attempt WHERE account_id=424243)),"
                      "(2,(SELECT COUNT(*)::text FROM booking_account_lock WHERE account_id=424243)),"
                      "(3,(SELECT COUNT(*)::text FROM legacy_booking_barrier WHERE account_id=424244)),"
                      "(4,(SELECT state FROM booking_attempt WHERE account_id=424245)),"
                       "(5,(SELECT COUNT(*)::text FROM booking_account_lock WHERE account_id=424245)),"
                       "(6,(SELECT COUNT(*)::text FROM booking_account_lock WHERE account_id=424247)),"
                       "(7,(SELECT COUNT(*)::text FROM information_schema.columns WHERE table_name='booking_attempt' AND column_name IN ('start_at','end_at','clinic_id','service_id','schedule_id','doctor_id','telemedicine','baseline_reservation_ids')))"
                       ") AS checks(position,result) ORDER BY position;").stdout.splitlines()
    assert recovery == ['failed:PREPARED_INTERRUPTED', '0', '0', 'unknown', '1', '1', '8'], recovery
    print('PG10 restart held unknown confirmation and unacknowledged success locks with recovery columns.', flush=True)
    docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-v', 'ON_ERROR_STOP=1', '-c',
           "INSERT INTO booking_attempt(id,account_id,fingerprint,state,created_at) VALUES ('00000000-0000-0000-0000-000000424242',424242,'fixture','unknown',1); INSERT INTO booking_account_lock(account_id,attempt_id) VALUES (424242,'00000000-0000-0000-0000-000000424242');")
    client('incorrect-key', expected_failure=True)
    client(ENCRYPTION_SECRET, expected_failure=True)
    assert docker('inspect', '--format', '{{.Id}}', DB).stdout.strip() == old_db_id
    assert docker('exec', DB, 'cat', '/var/lib/postgresql/data/PG_VERSION').stdout.strip() == '10'
    row = docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                 "SELECT username || ':' || password FROM credentials WHERE account_id=424242").stdout.strip()
    assert row == 'fixture-user:fixture-ciphertext'
    print('Watchtower updated the sidecar with unchanged environment, PG10 volume and credentials.', flush=True)

    # Explicit new secrets override the derived legacy key on both sides.
    docker('rm', '-f', SIDECAR)
    explicit_secret = secrets.token_hex(32)
    docker('run', '-d', '--name', SIDECAR, '--network', NETWORK,
           *legacy_env, '-e', 'DB_PASSWORD=lsb123', '-e', f'REST_SECRET={explicit_secret}', NEW_IMAGE)
    wait_health()
    client(explicit_secret, smart=True, persisted=True)
    assert docker('exec', DB, 'psql', '-U', 'lbs', '-d', 'lbs', '-Atc',
                  'SELECT COUNT(*) FROM booking_account_lock WHERE account_id=424247').stdout.strip() == '0'
    client(expected_failure=True)
    print('Explicit REST secret overrides legacy authentication.', flush=True)
finally:
    for container in (BOT, SIDECAR, DB):
        docker('rm', '-f', container, check=False)
    docker('volume', 'rm', VOLUME, check=False)
    docker('volume', 'rm', BOT_VOLUME, check=False)
    docker('network', 'rm', NETWORK, check=False)
    docker('image', 'rm', TAG, check=False)
    docker('image', 'rm', BOT_TAG, check=False)
