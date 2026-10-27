# cluenori-watch

Watches a Cluenori deployment from outside and alerts its owners when it's down. Cluenori can't
tell anyone it's down while it's down. This repository's GitHub Actions schedule can: it rings
the owners' iPhones through APNs, which is Apple's service and needs neither Cloudflare nor
Cluenori, and also writes to Telegram and sends email.

## What it does

Every 5 minutes (GitHub's shortest schedule, which GitHub may start late or skip under load), it
asks `<deployment>/api/health`. A 2xx answer means up. Any other status, a redirect, no answer in
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
- **A failed send is sent again,** through that channel only, on the next runs, for an hour.

The issue is the only state, and it records each alert's delivery by channel. Before a run sends,
it records the channels it is about to send through; after, which of them failed. If it can't
record first, nothing is sent, so a broken run never sends Down every 5 minutes. If it stops after
sending and before recording how it went, those channels aren't sent that alert again: it may have
arrived, and an alert never comes twice. Only an issue that this workflow opened and labelled
`cluenori-down` counts, so an issue a stranger opens never counts as an outage, even when someone
labels it. What the run writes to the issue is redacted like its log: the repository is public.

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

- GitHub may start a scheduled run late, or skip it, under load, so Down can come several minutes
  after the outage began.
- GitHub turns off schedules in a public repository after 60 days without activity. A weekly job
  turns the workflow back on so that never happens.
- Telegram's bot only sends. It never reads updates or sets a webhook, so the same bot can later
  also be a Cluenori notification client.
