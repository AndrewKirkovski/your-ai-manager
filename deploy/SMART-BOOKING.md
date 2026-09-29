# Smart LuxMed booking

New monitors ask when appointments can be booked. The user describes free times,
recurring commitments, exceptions and locations in chat. The bot saves a draft,
shows a decision preview and sends a **Confirm availability** button. Automatic
booking starts only after the user clicks that button in their private chat.
The preview states the exact clinic IDs, doctor IDs, language filter, booking
mode, and travel rules that will apply.
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
Keep the bot timezone at `Europe/Warsaw`. The sidecar interprets LuxMed local
appointment times in Warsaw, and smart booking pauses if the bot uses another
timezone.

Set `GOOGLE_ROUTES_CACHE_PERMITTED=true` only after confirming that the applicable
Google agreement permits the stored travel estimates. Lazy refresh is still
caching. The [published Routes terms](https://cloud.google.com/maps-platform/terms/maps-service-terms)
explicitly cover temporary coordinate caching, so permission for duration
profiles must not be assumed. The published [EEA Routes terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
likewise list coordinates, not route durations. Leave this flag unset unless
the applicable agreement separately permits storing duration and route details
for this use and retention period. Record that permission in the operator's
deployment records before enabling it.
Set `GOOGLE_GEOCODING_CACHE_PERMITTED=true` only after confirming that the
applicable agreement permits storing the resolved addresses and coordinates for
the required period. The [published EEA Geocoding terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms)
allow temporary caching of coordinates for 30 days and do not grant general
indefinite address storage.
Both permission checks must pass before smart booking starts.

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
workflow's `sidecar-after-bot` stage with that SHA, challenge, and the successful
Stage A workflow run ID (`staged_release_run_id`). The challenge must have 8 to
64 letters, digits, underscores or hyphens. CI checks the watched bot image
revision and compares the sidecar's SHA-256 image ID with the value saved by
that Stage A run before rehearsing or publishing the sidecar watched tag.
Changed sidecar image content blocks the release. CI cannot independently
observe Murzik; the Telegram response is the operator's evidence that Watchtower
replaced the bot. Without it, the sidecar stays on the older image. No
unauthenticated compatibility API is opened.
Later releases rehearse both image orders against the authenticated watched
baseline before publishing both tags. After a successful legacy booking under
a compatible mixed version, the sidecar holds later legacy manual bookings
until the new bot verifies and acknowledges the reservation. This prevents a
duplicate retry but can interrupt legacy booking if the bot update fails.
An old v2 bot cannot supply the exact reservation facts required by a v4
sidecar. A sidecar-first update therefore pauses its automatic smart booking
until Watchtower replaces the bot. Its unversioned booking POST receives a
definite `BOT_UPGRADE_REQUIRED` failure before any LuxMed provider call. In the
opposite image order, the new bot's `/booking-attempts/v4` POST has no matching
route on the v2 sidecar, so smart booking waits for the sidecar update. This is
a safe service pause, not continuous booking availability. The Watchtower
rehearsal checks both paths with fixture requests that cannot book a visit.
The current bot also requires the sidecar's `smart-booking-lockterm-review-v1`
capability. A bot-first update pauses smart booking until the sidecar checks
LuxMed's lockterm warnings, doctor identity, referral and procedure flags.
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
booking through the sidecar first records a durable account barrier. Smart booking waits while its
outcome is uncertain. After success, the bot clears the barrier only when a
complete reservation response for that visit's date shows the exact reservation
ID, or the bot has confirmed its cancellation. The bot checks barriers for linked
accounts in the background, including accounts without an active smart monitor.
A chat booking for an account absent from the bot account table remains held
until that account is registered or an operator reviews it.
A complete reservation feed that omits a previously seen visit does not prove
cancellation. Every dispatched DELETE leaves a pending receipt and holds new
bookings for that account. The sidecar never repeats that DELETE. An operator
must check the result in LuxMed, then review the exact reservation ID and start
through `POST /api/v1/accounts/{accountId}/visits/cancellation-receipts/{reservationId}/review`
with `expectedStartAt`, `action`, `operator`, `reason` and
`providerRequestSettled=true`. A confirmed cancellation also requires
`cancellationStatusVerified=true`: the operator verifies that exact reservation
ID was cancelled in LuxMed and the DELETE has settled. The sidecar checks a
complete broad reservation range; a moved visit or incomplete response keeps
the account held. The action is `confirmed_cancelled`,
`verified_still_reserved` or `verified_moved`. For a moved visit the operator
provides `expectedMovedStartAt`; the sidecar verifies the exact ID at the new
start in complete coverage of both dates and returns the new visit facts. The
bot refreshes that date, moves any saved booking block, and acknowledges the
move before the sidecar releases the account. The review is recorded in
an append-only audit table. The endpoint uses the existing sidecar REST secret;
the `operator` field is supplied by that caller and is not independently
authenticated. It is not exposed as a chatbot tool. A confirmed cancellation
releases occupied time.
For a still-reserved visit, the bot removes any old cancellation marker and
requires a fresh reservation feed to show that exact visit before booking
resumes. Prior confirmations based on absent feeds become pending during the
v2 database migration and need review. Smart booking requires the sidecar's
`cancellation-receipts-v3` capability, including during mixed image updates.
LuxMed's DELETE accepts a reservation ID without a conditional start time.
An external move between the sidecar's start-time check and the DELETE can
still cancel the moved visit. The pending receipt prevents an automatic retry;
the operator must inspect the result in LuxMed.

Smart searches target 30 seconds plus jitter. Requests are serialised per account,
with bookings ahead of queued searches. Effective polling intervals and decision
times are logged separately. `pollGapMs` measures time between actual search
starts, `searchMs` records the upstream search duration, and `bookingMs` records
the bot-to-sidecar booking request, including the LuxMed provider wait. The portal does not
report when a slot first became available, so the polling gap is the observable
discovery bound, not a measured publication timestamp. Throttling and failures
increase the retry interval.

Booking attempts and notifications are persisted. An uncertain response holds the
account while its attempt status and reservations are checked. A missing or
ambiguous receipt never permits an automatic duplicate attempt. The bot reports
possible matching reservations without guessing.

The sidecar records a prepared phase before each new smart or legacy booking
and records confirmation started before the provider confirmation call. After
a restart, it releases prepared work from an earlier process because that
process could not confirm without first changing the phase. A prior process's
confirmation-started attempt becomes unknown and stays locked. A successful
smart attempt keeps the account lock until the bot has saved the reservation
block, stopped the monitor, queued the notification and acknowledged the exact
attempt. The bot retries an unacknowledged success after restart. A shared
database permit covers legacy bookings, smart bookings, enrolment and
cancellation dispatch across sidecar processes.

For a new unknown smart attempt, an operator can inspect
`GET /api/v1/accounts/{accountId}/booking-attempts/{attemptId}/review-context`.
The sidecar stores the requested visit facts, the complete pre-submit
reservation ID set, and exact facts for the candidate's three-day comparison
window. Missing end time or location inside that window blocks booking;
unrelated visits outside it do not. Positive review uses
`POST /api/v1/accounts/{accountId}/booking-attempts/{attemptId}/review` with
the exact fingerprint, start, end, clinic and baseline from that context, the
new reservation ID, `serviceAndDoctorVerified=true`,
`providerRequestSettled=true`, `operator` and `reason`. The operator must verify
the service and doctor in LuxMed and establish that the original provider
request is no longer in flight. The sidecar also requires a complete exact-day
reservation response with the new ID, time and clinic or telemedicine type.
Review is audited and leaves the account locked until the bot records and
acknowledges success. The provider feed cannot prove which request created a
matching reservation, and a delayed provider response remains an operator
judgment. No absent feed or timeout clears an unknown attempt. Older attempts
without stored recovery facts remain held for manual investigation.

Notifications retry independently of booking. Confirmed cancellations remain
recorded so a late success receipt or a stale reservation feed cannot restore
the cancelled visit. Later travel or schedule conflicts generate a warning
without cancelling a visit.
If LuxMed returns a warning after a confirmed booking, the sidecar saves that
warning state with the successful outcome. The bot records the reservation and
asks the user to review its instructions in the LuxMed portal. Active smart
monitors request a reservation refresh before their snapshot reaches one minute
old, independently of the next appointment search.

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
It also checks the v3 recovery columns and keeps a successful attempt
locked across restart until the bot acknowledges it.
The authenticated v2 baseline rehearsal covers both image orders and the old
bot's reservation-only legacy barrier acknowledgement. It detects a watched v2
baseline from applied migrations and asserts that the migrated barrier clears.

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
