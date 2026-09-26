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

CI builds both images, runs the Scala suites, and rehearses an actual Watchtower
replacement against the July sidecar image and its PostgreSQL 10 schema. The
rehearsal checks the bot adapter before and after replacement, preserved
deployment settings, retained credential rows, rejected invalid auth, and
explicit secret overrides. It also starts the old and new bot against the same
SQLite volume and checks that account and address data survive repeated startup.
Only a passing main run publishes the watched
`latest` tags. Candidate branches do not publish. SHA tags identify each release.

The images are separate, so a short authentication error is possible if the
sidecar updates before the bot. Both images must finish updating. Monitorings
retain their retry behavior for temporary failures.

A passing release proves the upgrade on the reproduced configuration. Without
access to Murzik it cannot prove that Watchtower is running, registry credentials
are valid, or the LuxMed account can log in. No test books appointments or sends
Telegram messages.

# Manual setup and configuration

`setup.sh` is for fresh installations only and refuses an existing configuration.
`update.sh` is a manual Compose configuration updater. It preserves `.env` and
refuses to apply the PostgreSQL 16 configuration over an older database volume.
Do not run either script to complete an ordinary Watchtower image update.

After the bot updates, save the current address as the account's `home`
address through the bot. Home addresses are private account data, so the image does not
overwrite addresses for other users.
