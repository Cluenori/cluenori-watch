import { Cause, Config, Crypto, DateTime, Effect, Exit, Option, Redacted } from "effect"

import type { Alert } from "./alert.ts"
import { downAlert, recoveredAlert, reminderAlert, testAlert, timeText } from "./alert.ts"
import { apns } from "./apns.ts"
import type { Configured } from "./channel.ts"
import { secret, secretsOf } from "./channel.ts"
import { email } from "./email.ts"
import { checkHealth } from "./health.ts"
import type { Issues } from "./issues.ts"
import { makeIssues, stampText } from "./issues.ts"
import type { Decision, Health } from "./outage.ts"
import { afterFirst, afterSecond, confirmAfter } from "./outage.ts"
import type { Report } from "./report.ts"
import { makeReport } from "./report.ts"
import { telegram } from "./telegram.ts"

// What one run does: `watch` checks the deployment and alerts on a change; `test` sends a test
// through every channel. `DRY_RUN=true` shows what either would send, and sends and writes nothing.
const settings = Config.all({
  mode: Config.Literals(["watch", "test"], "MODE").pipe(Config.withDefault("watch" as const)),
  dryRun: Config.Boolean("DRY_RUN").pipe(Config.withDefault(false)),
  actions: Config.Boolean("GITHUB_ACTIONS").pipe(Config.withDefault(false)),
  summaryFile: Config.option(Config.String("GITHUB_STEP_SUMMARY")),
  repository: Config.String("GITHUB_REPOSITORY"),
  api: Config.String("GITHUB_API_URL").pipe(Config.withDefault("https://api.github.com")),
  server: Config.String("GITHUB_SERVER_URL").pipe(Config.withDefault("https://github.com")),
  runId: Config.option(Config.String("GITHUB_RUN_ID")),
})

const describeHealth = (health: Health) =>
  health._tag === "Up" ? `answered HTTP ${health.status}` : `failed: ${health.reason}`

/** Sends `alert` through every channel at once; one that fails stops none of the others. */
const sendAll = Effect.fn("sendAll")(function* (
  channels: ReadonlyArray<Configured>,
  alert: Alert,
  report: Report,
  dryRun: boolean,
) {
  const results = yield* Effect.forEach(
    channels,
    (configured) =>
      Effect.gen(function* () {
        switch (configured._tag) {
          case "Off":
            return Option.none<string>()
          case "Misconfigured":
            yield* report.failure(`${configured.name} isn't set up right: ${configured.reason}`)
            return Option.some(`${configured.name}: not set up right`)
          case "On": {
            const channel = configured.channel
            if (dryRun) {
              yield* report.line(`${channel.name} would send:\n\n\`\`\`\n${channel.preview(alert).join("\n")}\n\`\`\``)
              return Option.some(`${channel.name}: dry run`)
            }
            const sent = yield* channel.send(alert).pipe(Effect.result)
            if (sent._tag === "Success") {
              yield* report.line(`${channel.name}: sent, ${sent.success}.`)
              return Option.some(`${channel.name}: sent, ${sent.success}`)
            }
            yield* report.failure(`${channel.name} couldn't send "${alert.title}": ${sent.failure.reason}`)
            return Option.some(`${channel.name}: failed, ${sent.failure.reason}`)
          }
        }
      }),
    { concurrency: "unbounded" },
  )
  const said = results.flatMap(Option.toArray)
  if (said.length === 0) {
    yield* report.warning(`No channel is set up, so "${alert.title}" reached no one: see the README.`)
  }
  return said
})

/** One run of `watch`: check, confirm a change a minute later, then act on what changed. */
const watch = Effect.fn("watch")(function* (input: {
  readonly deployment: Redacted.Redacted<string>
  readonly issues: Issues
  readonly channels: ReadonlyArray<Configured>
  readonly report: Report
  readonly dryRun: boolean
  readonly runLink: string
}) {
  const { issues, report, dryRun } = input
  const crypto = yield* Crypto.Crypto
  const outage = yield* issues.open
  if (Option.isSome(outage)) {
    yield* report.line(`Down since ${stampText(outage.value.since)} (${outage.value.url}).`)
  }
  const firstAt = yield* DateTime.now
  const first = yield* checkHealth(input.deployment)
  yield* report.line(`Health check ${describeHealth(first)}.`)
  const early = afterFirst(outage, first, firstAt)
  let decision: Decision
  if (early._tag === "Confirm") {
    yield* report.line("That would change what's known, so a second check confirms it in a minute.")
    yield* Effect.sleep(confirmAfter)
    const second = yield* checkHealth(input.deployment)
    yield* report.line(`Second check ${describeHealth(second)}.`)
    decision = afterSecond(outage, first, firstAt, second)
  } else {
    decision = early
  }
  const now = yield* DateTime.now
  const results = (said: ReadonlyArray<string>) =>
    said.length === 0 ? "No channel is set up." : said.map((line) => `- ${line}`).join("\n")

  switch (decision._tag) {
    case "Up":
      return yield* report.line("Cluenori is up.")
    case "StillDown":
      return yield* report.line(
        `Still down: ${decision.reason}. Last alert at ${timeText(decision.outage.lastAlertAt)}; the next within the hour after it.`,
      )
    case "NotConfirmed":
      return yield* report.line("The second check didn't agree with the first, so nothing changes.")
    case "Down": {
      const alertId = yield* crypto.randomUUIDv4().pipe(Effect.orDie)
      if (dryRun) {
        yield* report.line("Down, confirmed. Would open an issue, then send:")
        yield* sendAll(
          input.channels,
          downAlert({ reason: decision.reason, alert: alertId, at: now, link: "<the issue>" }),
          report,
          true,
        )
        return
      }
      // The issue comes first: if it can't be opened, nothing is sent, so the next run doesn't
      // send Down again.
      const opened = yield* issues.openOutage({
        alert: alertId,
        since: decision.since,
        lastAlertAt: now,
        reason: decision.reason,
      })
      yield* report.line(`Down, confirmed: opened ${opened.url}.`)
      const said = yield* sendAll(
        input.channels,
        downAlert({ reason: decision.reason, alert: alertId, at: now, link: opened.url }),
        report,
        false,
      )
      yield* issues.comment(opened, `Alerted at ${stampText(now)}:\n\n${results(said)}\n\n[This run](${input.runLink})`)
      return
    }
    case "Remind": {
      const alert = (link: string) =>
        reminderAlert({
          reason: decision.reason,
          alert: decision.outage.alert,
          since: decision.outage.since,
          at: now,
          link,
        })
      if (dryRun) {
        yield* report.line("Still down, an hour after the last alert. Would remind:")
        yield* sendAll(input.channels, alert(decision.outage.url), report, true)
        return
      }
      // Recorded first, so a failure to record never sends a reminder every five minutes.
      const recorded = yield* issues.recordAlert(decision.outage, now)
      const said = yield* sendAll(input.channels, alert(recorded.url), report, false)
      yield* issues.comment(
        recorded,
        `Still down: ${decision.reason}. Reminded at ${stampText(now)}:\n\n${results(said)}\n\n[This run](${input.runLink})`,
      )
      return
    }
    case "Recovered": {
      const recovered = recoveredAlert({
        alert: decision.outage.alert,
        since: decision.outage.since,
        at: now,
        link: decision.outage.url,
      })
      if (dryRun) {
        yield* report.line("Recovered, confirmed. Would close the issue, then send:")
        yield* sendAll(input.channels, recovered, report, true)
        return
      }
      // Closed first, so Recovered is sent once.
      yield* issues.close(decision.outage)
      yield* report.line(`Recovered: closed ${decision.outage.url}.`)
      const said = yield* sendAll(input.channels, recovered, report, false)
      yield* issues.comment(
        decision.outage,
        `Recovered at ${stampText(now)}: ${recovered.body}\n\n${results(said)}\n\n[This run](${input.runLink})`,
      )
      return
    }
  }
})

/** One run of `test`: a test through every channel set up, each saying what took it. */
const test = Effect.fn("test")(function* (channels: ReadonlyArray<Configured>, report: Report, dryRun: boolean) {
  const crypto = yield* Crypto.Crypto
  const alert = testAlert({ alert: yield* crypto.randomUUIDv4().pipe(Effect.orDie), at: yield* DateTime.now })
  for (const configured of channels) {
    if (configured._tag === "Off") {
      yield* report.line(`${configured.name} is off: add ${configured.needs}.`)
    }
  }
  const said = yield* sendAll(channels, alert, report, dryRun)
  if (said.length === 0) {
    yield* report.failure("No channel is set up, so there was nothing to test.")
  }
})

/**
 * One run, as the environment sets it up: checks or tests, alerts, and what it said, for the run's
 * summary, and whether it failed.
 */
export const program = Effect.gen(function* () {
  const run = yield* settings
  const deployment = yield* secret("CLUENORI_URL")
  const token = yield* secret("GITHUB_TOKEN")
  const channels = [yield* apns, yield* telegram, yield* email]
  const report = yield* makeReport(
    [...Option.toArray(deployment), ...Option.toArray(token), ...channels.flatMap(secretsOf)],
    run.actions,
  )
  const runLink = Option.match(run.runId, {
    onNone: () => `${run.server}/${run.repository}/actions`,
    onSome: (id) => `${run.server}/${run.repository}/actions/runs/${id}`,
  })
  yield* report.line(`cluenori-watch: ${run.mode}${run.dryRun ? ", dry run: nothing is sent or written" : ""}.`)
  const outcome = yield* Effect.gen(function* () {
    if (run.mode === "test") {
      return yield* test(channels, report, run.dryRun)
    }
    if (Option.isNone(deployment)) {
      return yield* report.failure("CLUENORI_URL is missing: add the deployment's address as a repository secret.")
    }
    if (Option.isNone(token)) {
      return yield* report.failure("GITHUB_TOKEN is missing: the workflow passes it.")
    }
    const issues = yield* makeIssues({ api: run.api, repository: run.repository, token: Redacted.make(token.value) })
    yield* watch({ deployment: Redacted.make(deployment.value), issues, channels, report, dryRun: run.dryRun, runLink })
  }).pipe(Effect.exit)
  if (Exit.isFailure(outcome)) {
    const why = outcome.cause.reasons
      .map((reason) =>
        reason._tag === "Fail" && "reason" in reason.error ? String(reason.error.reason) : "an unexpected failure",
      )
      .join("; ")
    yield* report.failure(`The run stopped: ${why}. Nothing more was sent.`)
    yield* report.line(Cause.pretty(outcome.cause))
  }
  return { failed: report.failed(), summary: report.summary(), summaryFile: run.summaryFile }
})
