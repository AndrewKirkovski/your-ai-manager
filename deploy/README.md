# Automatic updates on existing hosts

Murzik's existing Watchtower container polls GHCR every five minutes. It can
replace the bot and sidecar images on any Wi-Fi with registry access. An SSH
connection, a new Compose file, and running `update.sh` are not needed for this
release. A host without registry access updates after access returns.

The release keeps the existing PostgreSQL 10 container and volume. It does not
attempt a PostgreSQL major-version upgrade or change stored login encryption.
The bot uses `LUXMED_SECURITY_SECRET` and the sidecar uses `SECURITY_SECRET` to
derive the same purpose-specific HMAC key when no explicit REST key is present.
An explicit `LUXMED_SIDECAR_SECRET` / `REST_SECRET` takes precedence. Requests
without a matching key are rejected.

The old sidecar used built-in database credentials while its Compose file passed
only the database host and port. The new image preserves that behavior only for
the matching legacy environment. Explicit database settings always take
precedence. Fresh installations require a database password in their config.

CI builds both images and runs the Scala and simulated booking suites. While the
watched sidecar is the older image, a passing main run advances only the bot
`latest` tag. Watchtower then replaces the bot while retaining the older sidecar.
The new bot keeps smart booking disabled until the sidecar advertises the needed
capabilities. CI also publishes immutable SHA tags for both images.

The pinned old bot does not send the REST authentication header required by the
new sidecar. Replacing the sidecar first would interrupt existing LuxMed actions.
After Watchtower replaces the bot, send a fresh `/version <challenge>` command
to the bot in a private chat. Check that it echoes the challenge and reports the
full SHA of the staged main release. Then run this workflow on `main` with
`release_stage=sidecar-after-bot` and `observed_bot_revision` set to that SHA.
Set `observed_challenge` to the echoed challenge. Choose a new challenge of 8 to
64 letters, digits, underscores or hyphens for each attempt.
The workflow checks the current main commit and watched bot image, rehearses
sidecar replacement against the already released bot image, and advances only
the sidecar `latest` tag. An absent or mismatched response leaves the sidecar
tag unchanged. The operator's Telegram observation is the trust boundary; CI
cannot independently inspect Murzik's running container.

Once the watched sidecar carries the authentication migration marker, ordinary
main releases again rehearse both replacement orders against the current watched
images before advancing both tags. Candidate branches do not publish. The
rehearsal checks preserved settings and volumes, stored credentials, invalid
authentication, and the old bot's SQLite reader. See
[smart booking rollout](SMART-BOOKING.md) for the mixed-image checks.

A passing release proves the upgrade on the reproduced configuration. Without
access to Murzik it cannot prove that Watchtower is running, registry credentials
are valid, or the LuxMed account can log in. No test books appointments or sends
Telegram messages.

# Manual setup and configuration

Smart booking adds availability confirmation, travel checks and Jev ranking.
Its [one-time setup](SMART-BOOKING.md) requires provider keys and caching permission.
Recreate only the bot with the host's existing configuration for that setup.
Later releases continue through Watchtower, with the current database and volumes.

`setup.sh` is for fresh installations only and refuses an existing configuration.
`update.sh` is a manual Compose configuration updater. It preserves `.env` and
refuses to apply the PostgreSQL 16 configuration over an older database volume.
Do not run either script to complete an ordinary Watchtower image update.

After the bot updates, save the current address as the account's `home`
address through the bot. Home addresses are private account data, so the image does not
overwrite addresses for other users.
