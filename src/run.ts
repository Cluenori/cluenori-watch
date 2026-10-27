import { Cause, Config, Crypto, DateTime, Effect, Exit, Option, Redacted } from "effect"

import type { Alert } from "./alert.ts"
import { downAlert, recoveredAlert, reminderAlert, testAlert, timeText } from "./alert.ts"
import { apns } from "./apns.ts"
import type { Configured } from "./channel.ts"
import { reasonText, secret, secretsOf } from "./channel.ts"
import { email } from "./email.ts"
import { checkHealth } from "./health.ts"
import type { Issues } from "./issues.ts"
import { makeIssues, stampText } from "./issues.ts"
import type { Decision, Delivery, Health, Outage } from "./outage.ts"
import { afterFirst, afterSecond, confirmAfter, remindEvery, stateOf } from "./outage.ts"
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

/** What one channel did with an alert: a line for the report, and whether to send it again: only when it definitely didn't arrive. */
interface Sent {
  readonly name: string
  readonly line: string
  readonly failed: boolean
}

/** The names of the channels that are on: the ones an alert is claimed for. */
const onNames = (channels: ReadonlyArray<Configured>) =>
  channels.flatMap((configured) => (configured._tag === "On" ? [configured.channel.name] : []))

/**
 * Sends `alert` through every channel at once, or only those named in `only`. One that fails, or
 * stops unexpectedly, stops none of the others. Every service's words are redacted, then shortened.
 */
const sendAll = Effect.fn("sendAll")(function* (
  channels: ReadonlyArray<Configured>,
  alert: Alert,
  report: Report,
  dryRun: boolean,
  only?: ReadonlyArray<string>,
) {
  const words = (text: string) => reasonText(report.redact(text))
  const chosen =
    only === undefined ? channels : channels.filter((each) => each._tag === "On" && only.includes(each.channel.name))
  const results = yield* Effect.forEach(
    chosen,
    (configured) =>
      Effect.gen(function* () {
        switch (configured._tag) {
          case "Off":
            return Option.none<Sent>()
          case "Misconfigured":
            yield* report.failure(`${configured.name} isn't set up right: ${configured.reason}`)
            return Option.some<Sent>({
              name: configured.name,
              line: `${configured.name}: not set up right`,
              failed: false,
            })
          case "On": {
            const channel = configured.channel
            if (dryRun) {
              yield* report.line(`${channel.name} would send:\n\n\`\`\`\n${channel.preview(alert).join("\n")}\n\`\`\``)
              return Option.some<Sent>({ name: channel.name, line: `${channel.name}: dry run`, failed: false })
            }
            // The whole send, defects included, so a channel that breaks never interrupts another.
            const sent = yield* channel.send(alert).pipe(Effect.exit)
            if (Exit.isSuccess(sent)) {
              yield* report.line(`${channel.name}: sent, ${words(sent.value)}.`)
              return Option.some<Sent>({
                name: channel.name,
                line: `${channel.name}: sent, ${words(sent.value)}`,
                failed: false,
              })
            }
            const failure = Cause.findErrorOption(sent.cause)
            // A channel that broke may have broken after sending: what it did is unknown.
            const delivery = Option.isSome(failure) ? failure.value.delivery : "unknown"
            const why = Option.isSome(failure) ? words(failure.value.reason) : "it stopped unexpectedly"
            if (delivery === "final") {
              yield* report.warning(`${channel.name} won't take "${alert.title}": ${why}`)
              return Option.some<Sent>({ name: channel.name, line: `${channel.name}: not sent, ${why}`, failed: false })
            }
            if (delivery === "unknown") {
              yield* report.failure(
                `${channel.name} may not have sent "${alert.title}": ${why}. It may have arrived, so it isn't sent again.`,
              )
              return Option.some<Sent>({
                name: channel.name,
                line: `${channel.name}: unknown, ${why}; not sent again, as it may have arrived`,
                failed: false,
              })
            }
            yield* report.failure(`${channel.name} couldn't send "${alert.title}": ${why}`)
            return Option.some<Sent>({ name: channel.name, line: `${channel.name}: failed, ${why}`, failed: true })
          }
        }
      }),
    { concurrency: "unbounded" },
  )
  const sent = results.flatMap(Option.toArray)
  if (sent.length === 0 && only === undefined) {
    yield* report.warning(`No channel is set up, so "${alert.title}" reached no one: see the README.`)
  }
  return sent
})

/**
 * The alert `outage`'s delivery is of, sent at `sentAt`: its words as when it was first sent, and
 * the time it goes, which the phone reads to ring an alarm only while it is fresh.
 */
const alertOf = (outage: Outage, delivery: Delivery, sentAt: DateTime.Utc): Alert => ({
  ...firstAlertOf(outage, delivery),
  at: sentAt,
})

const firstAlertOf = (outage: Outage, delivery: Delivery): Alert => {
  switch (delivery.kind) {
    case "Down":
      return downAlert({ reason: outage.reason, alert: outage.alert, at: delivery.at, link: outage.url })
    case "Reminder":
      return reminderAlert({
        reason: outage.reason,
        alert: outage.alert,
        since: outage.since,
        at: delivery.at,
        link: outage.url,
      })
    case "Recovered":
      return recoveredAlert({ alert: outage.alert, since: outage.since, at: delivery.at, link: outage.url })
  }
}

/** One run of `watch`: finish what an earlier run left, check, confirm a change a minute later, then act on it. */
const watch = Effect.fn("watch")(function* (input: {
  readonly deployment: Redacted.Redacted<string>
  readonly issues: Issues
  readonly channels: ReadonlyArray<Configured>
  readonly report: Report
  readonly dryRun: boolean
  readonly runLink: string
}) {
  const { issues, report, dryRun, channels } = input
  const crypto = yield* Crypto.Crypto
  const results = (sent: ReadonlyArray<Sent>) =>
    sent.length === 0 ? "No channel is set up." : sent.map((each) => `- ${each.line}`).join("\n")
  const thisRun = `[This run](${input.runLink})`

  // Sends the alert `claimed`'s delivery is of through the channels it claims, then records those
  // that failed, to retry. A failure to record leaves them claimed: never sent again.
  const deliver = Effect.fn("deliver")(function* (claimed: Outage, delivery: Delivery, heading: string) {
    const sent = yield* sendAll(
      channels,
      alertOf(claimed, delivery, yield* DateTime.now),
      report,
      false,
      delivery.claimed,
    )
    const retry = sent.filter((each) => each.failed).map((each) => each.name)
    const recorded = yield* issues.update(claimed, {
      ...stateOf(claimed),
      delivery: { ...delivery, claimed: [], retry },
    })
    const next = retry.length === 0 ? "" : `\n\nSent again on the next runs, for an hour: ${retry.join(", ")}.`
    yield* issues.comment(recorded, `${heading}:\n\n${results(sent)}${next}\n\n${thisRun}`)
    return recorded
  })

  // What an earlier run left: a delivery whose outcome is unknown, channels to retry, and a
  // recovered outage to close once nothing is left to send. The outage as it is after, or none
  // when its issue closed.
  const finish = Effect.fn("finish")(function* (outage: Outage) {
    let current = outage
    const left = current.delivery
    if (left !== undefined && left.claimed.length > 0) {
      const unknown = `${left.kind} through ${left.claimed.join(", ")}: unknown. The run sending it stopped before saying how it went, so it isn't sent again.`
      yield* report.warning(unknown)
      if (!dryRun) {
        current = yield* issues.update(current, { ...stateOf(current), delivery: { ...left, claimed: [] } })
        yield* issues.comment(current, `${unknown}\n\n${thisRun}`)
      }
    }
    const pending = current.delivery
    if (pending !== undefined && pending.retry.length > 0) {
      const now = yield* DateTime.now
      const names = pending.retry.join(", ")
      if (DateTime.isGreaterThanOrEqualTo(now, DateTime.addDuration(pending.at, remindEvery))) {
        const given = `${pending.kind} never reached ${names} in the hour after ${timeText(pending.at)}, so it isn't sent again.`
        yield* report.failure(given)
        if (!dryRun) {
          current = yield* issues.update(current, { ...stateOf(current), delivery: { ...pending, retry: [] } })
          yield* issues.comment(current, `${given}\n\n${thisRun}`)
        }
      } else if (dryRun) {
        yield* report.line(`Would send ${pending.kind} again through ${names}:`)
        yield* sendAll(channels, alertOf(current, pending, yield* DateTime.now), report, true, pending.retry)
      } else {
        yield* report.line(`Sending ${pending.kind} again through ${names}.`)
        const again: Delivery = { ...pending, claimed: pending.retry, retry: [] }
        const claimed = yield* issues.update(current, { ...stateOf(current), delivery: again })
        current = yield* deliver(claimed, again, `${pending.kind}, sent again at ${stampText(now)}`)
      }
    }
    const done =
      current.delivery === undefined || (current.delivery.claimed.length === 0 && current.delivery.retry.length === 0)
    if (current.recoveredAt !== undefined && done && !dryRun) {
      yield* issues.close(current)
      yield* report.line(`Recovered reached every channel it could: closed ${current.url}.`)
      return Option.none<Outage>()
    }
    return Option.some(current)
  })

  // Every open outage: at most one down, and any recovered ones still sending Recovered, which
  // stops their alarms; each closes once nothing is left to send.
  const found = yield* issues.open
  const outages: Array<Outage> = []
  for (const each of found) {
    outages.push(...Option.toArray(yield* finish(each)))
  }
  // A recovered outage isn't down: its checks start from up.
  const active = Option.fromUndefinedOr(outages.find((each) => each.recoveredAt === undefined))
  if (Option.isSome(active)) {
    yield* report.line(`Down since ${stampText(active.value.since)} (${active.value.url}).`)
  }
  const firstAt = yield* DateTime.now
  const first = yield* checkHealth(input.deployment)
  yield* report.line(`Health check ${describeHealth(first)}.`)
  const early = afterFirst(active, first, firstAt)
  let decision: Decision
  if (early._tag === "Confirm") {
    yield* report.line("That would change what's known, so a second check confirms it in a minute.")
    yield* Effect.sleep(confirmAfter)
    const second = yield* checkHealth(input.deployment)
    yield* report.line(`Second check ${describeHealth(second)}.`)
    decision = afterSecond(active, first, firstAt, second)
  } else {
    decision = early
  }
  const now = yield* DateTime.now

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
          channels,
          downAlert({ reason: decision.reason, alert: alertId, at: now, link: "<the issue>" }),
          report,
          true,
        )
        return
      }
      // The issue comes first, claiming every channel: if it can't be opened, nothing is sent, so
      // the next run doesn't send Down again.
      const delivery: Delivery = { kind: "Down", at: now, claimed: onNames(channels), retry: [] }
      const opened = yield* issues.openOutage({
        alert: alertId,
        since: decision.since,
        lastAlertAt: now,
        reason: decision.reason,
        delivery,
      })
      yield* report.line(`Down, confirmed: opened ${opened.url}.`)
      yield* deliver(opened, delivery, `Alerted at ${stampText(now)}`)
      return
    }
    case "Remind": {
      const delivery: Delivery = { kind: "Reminder", at: now, claimed: onNames(channels), retry: [] }
      if (dryRun) {
        yield* report.line("Still down, an hour after the last alert. Would remind:")
        yield* sendAll(channels, alertOf({ ...decision.outage, reason: decision.reason }, delivery, now), report, true)
        return
      }
      // Recorded first, so a failure to record never sends a reminder every five minutes. A
      // reminder replaces whatever was left of the last alert's delivery.
      const claimed = yield* issues.update(decision.outage, {
        ...stateOf(decision.outage),
        reason: decision.reason,
        lastAlertAt: now,
        delivery,
      })
      yield* deliver(claimed, delivery, `Still down: ${decision.reason}. Reminded at ${stampText(now)}`)
      return
    }
    case "Recovered": {
      const delivery: Delivery = { kind: "Recovered", at: now, claimed: onNames(channels), retry: [] }
      if (dryRun) {
        yield* report.line("Recovered, confirmed. Would send, then close the issue:")
        yield* sendAll(channels, alertOf(decision.outage, delivery, now), report, true)
        return
      }
      // Recorded first, so Recovered is sent once; the issue closes once it reached every channel.
      const claimed = yield* issues.update(decision.outage, { ...stateOf(decision.outage), recoveredAt: now, delivery })
      const recorded = yield* deliver(claimed, delivery, `Recovered at ${stampText(now)}`)
      if (recorded.delivery?.retry.length === 0) {
        yield* issues.close(recorded)
        yield* report.line(`Recovered: closed ${recorded.url}.`)
      }
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
  const channels: ReadonlyArray<Configured> = [...(yield* apns), yield* telegram, yield* email]
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
    const issues = yield* makeIssues({
      api: run.api,
      repository: run.repository,
      token: Redacted.make(token.value),
      redact: report.redact,
    })
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
