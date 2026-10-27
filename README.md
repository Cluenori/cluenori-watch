# cluenori-watch

Watches a Cluenori deployment from outside and alerts its owners when it's down. Cluenori can't
tell anyone it's down while it's down. This repository's GitHub Actions schedule can: it rings
the owners' iPhones through APNs, which is Apple's service and needs neither Cloudflare nor
Cluenori, and also writes to Telegram and sends email.

## What it does

Every 5 minutes it asks `<deployment>/api/health`. A watching run checks on every 5-minute mark for
5 h 40 min, then starts the next watching run, so the watch doesn't depend on GitHub's schedule,
which may start runs late, skip them, or, for a new repository, not start them at all. The schedule
stays as a backstop that starts a watching run again if the chain ever breaks. Runs that write the
outage's state go one at a time, and each check reads that state from the issue afresh, so a
handover between runs loses nothing and sends nothing twice. A 2xx answer means up. Any other status, a redirect, no answer in
10 s or no connection means down.

- **Down** is sent only after two checks a minute apart fail. It goes through APNs as an alarm that
  rings like Cluenori's own Down incidents, and through Telegram and email. An issue labelled
  `cluenori-down` opens; it holds the outage's state.
- **Still down** goes once an hour while the outage lasts, as a time-sensitive push, not an alarm.
- **Recovered** goes once, after two checks a minute apart answer. It's a quiet push that stops
  the alarm, and the issue closes once it reached every channel.
- A failure that the second check doesn't confirm changes nothing and sends nothing.
- One channel failing, or breaking, never stops the others. A failed send fails the run, so it
  shows red with the reason, and the issue's comment lists what each channel did.
- **A send the service refused is sent again,** through that channel only (each phone is its own
  channel), on the next runs, for an hour, timed as sent then so a late Down still rings.

The issue is the only state, and it records each alert's delivery by channel (a phone by its
token's SHA-256, never the token). Every alert is sent at most once per attempt,
and an alert that may have arrived is never sent again:

- Before a run sends, it records the channels it is about to send through; after, which of them
  refused. If it can't record first, nothing is sent, so a broken run never sends Down every 5
  minutes.
- **Refused** (the service answered no: a 5xx, a bad token): sent again on the next runs.
- **Unknown** (no answer: a timeout, a dropped connection; an answer that doesn't say it worked; a
  channel that broke): it may have arrived, so it isn't sent again. The run fails, and the issue
  says so.
- **Final** (a phone without the app, an address that bounced): not sent again.

**What this gives up:** an alert can be lost, never doubled. If a run stops after recording the
channels and before recording how sending went (the runner dies, or GitHub's answer to that write
is lost), those channels count as unknown and aren't sent that alert again, though it may never
have gone. A Down lost this way is followed by the hourly reminder. A Recovered lost this way isn't
sent at all, so an alarm still ringing is stopped by hand on the phone, and the issue says so.

Only an issue that this workflow opened and labelled `cluenori-down` counts, so an issue a stranger
opens never counts as an outage, even when someone labels it. A recovered outage's issue stays open
until Recovered reached every channel, or for an hour, even if a new outage opens meanwhile, so the
old alarm still gets its stop. What the run writes to the issue is redacted like its log: the
repository is public.

## Set it up

Every channel turns on when its secrets exist (Settings → Secrets and variables → Actions → New
repository secret). The repository is public: secrets go there, never into files.

1. **The deployment:** `CLUENORI_URL`, its address, such as `https://cluenori.example`.
2. **The iPhone (APNs):** nothing to add by hand. In Cluenori, on the GitHub page or with
   `./cluenori watcher set <owner>/cluenori-watch`, an owner names this repository. Cluenori then
   writes `CLUENORI_APNS_KEY` (its APNs key) and `CLUENORI_PHONES` (every owner's phone that has
   notifications on) through its GitHub App, and writes them again whenever they change. The app
   needs **Secrets: Read and write** on this repository. If Cluenori is down, the last ones written
   are used.
3. **Telegram:**
   1. In Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, and pick a name.
      It answers with the bot's token: that's `TELEGRAM_BOT_TOKEN`.
   2. Open your new bot and send it any message.
   3. Open `https://api.telegram.org/bot<token>/getUpdates` and copy `result[0].message.chat.id`:
      that's `TELEGRAM_CHAT_ID`.
4. **Email, through Cloudflare Email Sending:**
   1. Onboard a sending domain on a zone in Cloudflare: Compute → Email Service → Email Sending, or
      `wrangler email sending enable notify.example.com`. It adds the domain's SPF, DKIM and DMARC
      records.
   2. Create an API token with **Email Sending: Edit** on your account: that's
      `CLOUDFLARE_EMAIL_TOKEN`.
   3. Add `CLOUDFLARE_ACCOUNT_ID`, `EMAIL_FROM` (an address on that domain, such as
      `watch@notify.example.com`) and `EMAIL_TO`.

   Sending to any address takes the Workers Paid plan. New accounts start with a small daily quota.
   Sending to a verified destination address of the account is always free.

Then check every channel: Actions → Watch → Run workflow, mode `test`. Each channel says what took
the message. With `dry_run` on, a run shows exactly what each channel would send, secrets masked,
and sends and writes nothing.

## Run it here

Node 26, whose `fetch` speaks HTTP/2 as APNs needs.

```sh
npm install
npm run check && npm test
GITHUB_REPOSITORY=you/cluenori-watch GITHUB_TOKEN=$(gh auth token) CLUENORI_URL=https://cluenori.example DRY_RUN=true node src/main.ts
```

## Limits

- A watching run is a GitHub-hosted job that is busy for 5 h 40 min at a time, mostly asleep
  between checks. GitHub's terms for Actions ask for no burden disproportionate to its benefit and
  for use related to the repository's software; a monitor running all day is a gray zone, and
  GitHub may stop such jobs or disable the repository. To stop watching, disable the Watch
  workflow; a run cancelled by hand starts no next one.
- Nothing notices a broken chain on its own: if a run dies without starting the next (a runner
  lost, GitHub down), only GitHub's schedule starts one again. A run that can't start the next one
  fails red and says so.
- GitHub turns off schedules in a public repository after 60 days without activity. A weekly job
  turns the workflow back on so that never happens.
- Telegram's bot only sends. It never reads updates or sets a webhook, so the same bot can later
  also be a Cluenori notification client.
