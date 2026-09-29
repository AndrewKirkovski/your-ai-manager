# Smart LuxMed booking

New monitors ask when appointments can be booked. The user describes free times,
recurring commitments, exceptions and locations in chat. The bot saves a draft,
shows a decision preview and sends a **Confirm availability** button. Automatic
booking starts only after the user clicks that button in their private chat.
Existing monitors retain their previous behaviour until explicitly enrolled.
Chat booking through the new bot also requires a confirmed availability policy.
The bot uses the same durable booking coordinator for a selected slot, so a
missing policy or older sidecar returns a setup status without submitting it.

Availability includes the whole journey. The bot checks the preceding commitment,
clinic check-in, the full appointment and travel to the next commitment or home.
Linked commitments remain separate from reminder times. Ordinary reminders do not
block appointments. Unresolved dates, locations, preparation or visit durations
prevent automatic booking for the affected candidates.
Travel locations require a separately verified street address. Saved coordinates
alone are not proof of a home or commitment location. Clinic street, building
number and city must match the LuxMed search city. An existing reservation with
an unverified clinic location cannot serve as a travel origin.

The earliest feasible day has priority. Public transport is preferred within that
day, with taxi fallback. Jev ranks up to five eligible candidates against soft
preferences. Only fixed categories such as morning, afternoon and shorter travel
are sent to OpenRouter. Free-form descriptions stay in the bot. Its 800 ms
deadline, invalid output or temporary failure uses the
confirmed deterministic ranking. The model cannot override schedule or travel
checks. The default buffers are 5 minutes after a commitment, 10 minutes for
check-in, 10 minutes after a visit and 5 minutes for taxi pickup.

## One-time operator setup

Add `OPENROUTER_API_KEY` and `GOOGLE_MAPS_API_KEY` to the deployment's existing
environment file. Enable Google Routes and Geocoding for that Maps project.
The OpenRouter integration uses `typesafe/jev-1.13` and the Decisions API.
Keep keys out of chat history, source control and logs.

Set `GOOGLE_ROUTES_CACHE_PERMITTED=true` only after confirming that the applicable
Google agreement permits the stored travel estimates. Lazy refresh is still
caching. Google's standard Routes caching exception explicitly covers coordinates,
so permission for duration profiles must not be assumed.

Recreate only the bot service using the deployment's existing Compose file:

```sh
docker compose up -d --no-deps --force-recreate bot
```

Do not replace that Compose file with the repository's fresh-install configuration.
Preserve the current database image, volumes, encryption secret and sidecar
configuration. Watchtower preserves container environment, so editing an env file
alone does not inject a new key. Subsequent image updates remain Watchtower updates.
The first authenticated sidecar release has two Watchtower stages. CI publishes
the bot watched tag while keeping the older sidecar watched tag in place. Once
the running bot answers a fresh private `/version <challenge>` request with the
staged release's full SHA and matching challenge, the operator dispatches the
workflow's `sidecar-after-bot` stage with that SHA and challenge. The challenge
must have 8 to 64 letters, digits, underscores or hyphens. CI checks the watched bot
image revision and rehearses the replacement before publishing the sidecar
watched tag. CI cannot independently observe Murzik; the Telegram response is
the operator's evidence that Watchtower replaced the bot. Without it, the
sidecar stays on the older image. No unauthenticated compatibility API is opened.
Later releases rehearse both image orders against the authenticated watched
baseline before publishing both tags. After a successful legacy booking under
a compatible mixed version, the sidecar holds later legacy manual bookings
until the new bot verifies and acknowledges the reservation. This prevents a
duplicate retry but can interrupt legacy booking if the bot update fails.
Smart booking waits if configuration or sidecar capabilities are missing.
Enrolment stores the intended auto-book setting in smart-monitor state and clears
the old monitor's auto-book flag. An older bot image therefore cannot resume
unchecked auto-booking after a rollback. The preview lists every active sidecar
automatic monitor on the account. The sidecar accepts enrolment only when that
exact list is still current. Under the account booking lock it stops them all
and records the enrolment marker in one transaction. A changed list requires
a new preview. The marker blocks the legacy manual booking endpoint even if an
older bot image is restored while the new sidecar remains in place.
The sidecar also rejects smart enrolment when the same normalized LuxMed login
belongs to more than one internal account. A later duplicate login or legacy
booking is rejected while an account with that login is enrolled. This check
uses the login name; distinct login names for one underlying patient have not
been verified as the same identity.
Rolling the sidecar back to an image without the enrolment fence removes that
protection for an older bot image. Keep the updated sidecar in place after
enrolment; pause booking and roll forward if that capability disappears.

## Travel and booking behaviour

Relevant location pairs are prepared for 08:00, 13:00 and 17:30 on a weekday,
Saturday and Sunday, in both directions and both modes. These profiles help
preparation; automatic booking requires a route matching the actual travel date
and a departure window no wider than 15 minutes. Holidays therefore use their
actual calendar date. Taxi estimates include traffic, but do not guarantee that
a taxi will be available.

A cache lookup returns the previous estimate and schedules a live refresh.
Refreshes for the same request are combined, with a five-minute cooldown and two
Google workers. Exact candidate requests have priority. Matching future estimates
expire after 24 hours; departures within two hours require estimates under ten
minutes old. Cached journeys add the larger of five minutes or 20 percent of the
journey duration. Missing or unsuitable estimates require live verification.
The sidecar requests reservations over an explicit date range and accepts only
an upstream response marked as complete. Missing coverage or an incomplete
response keeps automatic booking paused. Smart submissions also reject unknown
or nonzero prices and referral requirements until the user can review them.
The sidecar records a failed smart attempt without contacting LuxMed while any
sidecar-owned automatic monitor is active for the account. Those monitors keep
running until the user confirms account-wide enrolment or stops them. A legacy
booking through the
sidecar first records a durable account barrier. Smart booking waits while its
outcome is uncertain. After success, the bot clears the barrier only when a
complete reservation response for that visit's date shows the exact reservation
ID, or the bot has confirmed its cancellation. The bot checks barriers for linked
accounts in the background, including accounts without an active smart monitor.
A complete reservation feed that omits a previously seen visit does not prove
cancellation. Every dispatched DELETE leaves a pending receipt and holds new
bookings for that account. The sidecar never repeats that DELETE. An operator
must check the result in LuxMed, then review the exact reservation ID and start
through `POST /api/v1/accounts/{accountId}/visits/cancellation-receipts/{reservationId}/review`
with `expectedStartAt`, `action`, `operator` and `reason`. The action is
`confirmed_cancelled` or `verified_still_reserved`. The review is recorded in
an append-only audit table. The endpoint uses the existing sidecar REST secret;
the `operator` field is supplied by that caller and is not independently
authenticated. It is not exposed as a chatbot tool. A confirmed cancellation
releases occupied time.
For a still-reserved visit, the bot removes any old cancellation marker and
requires a fresh reservation feed to show that exact visit before booking
resumes. Prior confirmations based on absent feeds become pending during the
v2 database migration and need review. Smart booking requires the sidecar's
`cancellation-receipts-v2` capability, including during mixed image updates.

Smart searches target 30 seconds plus jitter. Requests are serialised per account,
with bookings ahead of queued searches. Effective polling intervals and decision
times are logged separately. `pollGapMs` measures time between actual search
starts, and `searchMs` records the upstream request duration. The portal does not
report when a slot first became available, so the polling gap is the observable
discovery bound, not a measured publication timestamp. Throttling and failures
increase the retry interval.

Booking attempts and notifications are persisted. An uncertain response holds the
account while its attempt status and reservations are checked. A missing or
ambiguous receipt never permits an automatic duplicate attempt. If the upstream
outcome remains unknown, the user must verify it; the bot reports possible matching
reservations without guessing. The sidecar records a prepared phase before
each new smart or legacy booking and records confirmation started before the
provider confirmation call. After a restart, it releases prepared work from
an earlier process because that process could not confirm without first
changing the phase. A concurrent earlier process loses its conditional phase
update and must not call the provider. Attempts that reached confirmation and
older rows without a phase remain held. There is no evidence-bound operator
resolution tool for those rows, so an unresolved attempt requires manual
investigation before booking can resume. Notifications retry
independently of booking. Confirmed cancellations remain recorded so a late
success receipt or a stale reservation feed cannot restore the cancelled visit.
Later travel or schedule conflicts generate a warning without cancelling a visit.

## Verification

Run `yarn typecheck`, `yarn test:luxmed` and the sidecar's full `./gradlew test`
suite with Java 25.
The Gradle Scala formatter is configured only at the root project, so its
`checkScalafmtAll` task does not check API or server sources. CI uses their
tests and build; a module formatting gate remains to be established without
reformatting unrelated older files.

CI rehearses the bot-first transition through Watchtower
on PostgreSQL 10. The sidecar stage rehearses replacement with the already
released bot image after operator observation. Once the authentication migration
marker is on the watched sidecar, every ordinary release rehearses both image
orders. The checks preserve uncertain attempts through restart and verify that
the older sidecar cannot enable smart booking. The bot rehearsal preserves its SQLite
volume and starts the old bot's database and clinic cache code against the
migrated file. The new bot stores same-named clinics in a separate city-scoped
table while the old table keeps its original unique-name contract. Legacy clinic
coordinates are cleared during migration so an old name-only lookup cannot reuse
another city's location. All automated booking tests use fixtures. Each release
candidate requires a fresh image replacement rehearsal with a working Docker daemon.
For an authenticated v1 baseline, the rehearsal seeds a previously confirmed
cancellation and verifies that PostgreSQL 10 moves it to pending review with an
audit entry in both image orders.

After configuring keys, run the optional read-only provider check:

```sh
RUN_LUXMED_LIVE_READONLY=yes node --import tsx tests/luxmed-smart-live.ts
```

It requests Google routes between public coordinates in Warsaw and a Jev ranking.
It never contacts LuxMed or books an appointment. Provider billing applies. Live
polling and booking latency require measurement after deployment; the target p95
decision time of 1.5 seconds is not a measured production guarantee.

References: [Google Routes](https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRouteMatrix),
[Google caching terms](https://cloud.google.com/maps-platform/terms/maps-service-terms),
and [OpenRouter Jev](https://openrouter.ai/blog/tutorials/how-to-use-jev/).
