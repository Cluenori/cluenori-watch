import { DateTime, Duration, Option, Schema } from "effect"

/** What one check of `<deployment>/api/health` found: a 2xx answer, or why not. */
export type Health =
  | { readonly _tag: "Up"; readonly status: number }
  /** `HTTP 503`, `no answer in 10 s`, `couldn't connect (ENOTFOUND)`: never the URL. */
  | { readonly _tag: "Down"; readonly reason: string }

/**
 * What the open issue keeps of an outage, in its body: the UUID its alerts ring under, when it
 * began, when the last alert went, and why.
 */
export const OutageState = Schema.Struct({
  alert: Schema.String.check(Schema.isUUID()),
  since: Schema.DateTimeUtcFromString,
  lastAlertAt: Schema.DateTimeUtcFromString,
  reason: Schema.String,
})
export type OutageState = typeof OutageState.Type

/** An outage: its state, and the open issue that holds it. */
export interface Outage extends OutageState {
  readonly issue: number
  readonly url: string
}

/** Reminders while it stays down come this far apart, at most. */
export const remindEvery = Duration.hours(1)

/** A change is confirmed by a second check this much later. */
export const confirmAfter = Duration.minutes(1)

/** What a run does, from the open outage and its checks. */
export type Decision =
  /** Up, as before. */
  | { readonly _tag: "Up"; readonly status: number }
  /** Down, as before, and reminded within the hour. */
  | { readonly _tag: "StillDown"; readonly outage: Outage; readonly reason: string }
  /** The first check said it changed, and the one a minute later didn't: nothing changes. */
  | { readonly _tag: "NotConfirmed"; readonly first: Health; readonly second: Health }
  /** Two checks a minute apart failed: open an outage, and alert. */
  | { readonly _tag: "Down"; readonly reason: string; readonly since: DateTime.Utc }
  /** Down for another hour since the last alert: remind. */
  | { readonly _tag: "Remind"; readonly outage: Outage; readonly reason: string }
  /** Two checks a minute apart answered: close the outage, and say so once. */
  | { readonly _tag: "Recovered"; readonly outage: Outage }

/**
 * What the first check means, at `now`: a decision when it changes nothing (up as before; down as
 * before, with a reminder when an hour passed since the last alert), else `Confirm`: it says up
 * while an outage is open, or down while none is, and a second check a minute later decides.
 */
export const afterFirst = (
  outage: Option.Option<Outage>,
  first: Health,
  now: DateTime.Utc,
): Decision | { readonly _tag: "Confirm" } => {
  if (Option.isNone(outage)) {
    return first._tag === "Up" ? { _tag: "Up", status: first.status } : { _tag: "Confirm" }
  }
  if (first._tag === "Up") {
    return { _tag: "Confirm" }
  }
  const due = DateTime.isGreaterThanOrEqualTo(now, DateTime.addDuration(outage.value.lastAlertAt, remindEvery))
  return due
    ? { _tag: "Remind", outage: outage.value, reason: first.reason }
    : { _tag: "StillDown", outage: outage.value, reason: first.reason }
}

/**
 * What a second check, a minute after `first` (made at `firstAt`), decides: the change, when both
 * agree; else nothing changes.
 */
export const afterSecond = (
  outage: Option.Option<Outage>,
  first: Health,
  firstAt: DateTime.Utc,
  second: Health,
): Decision => {
  if (Option.isNone(outage)) {
    return second._tag === "Down"
      ? { _tag: "Down", reason: second.reason, since: firstAt }
      : { _tag: "NotConfirmed", first, second }
  }
  return second._tag === "Up" ? { _tag: "Recovered", outage: outage.value } : { _tag: "NotConfirmed", first, second }
}
