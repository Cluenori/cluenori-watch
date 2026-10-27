import { DateTime, Duration, Option } from "effect"

/**
 * How an alert reaches the phone, as Cluenori's own alerts do: `alarm` rings through silent mode
 * and Do Not Disturb, `timeSensitive` breaks through a Focus with a sound, `quiet` shows without
 * one and stops the alarm.
 */
export type AlertLevel = "alarm" | "timeSensitive" | "quiet"

/** What one alert says, the same words on every channel. */
export interface Alert {
  readonly level: AlertLevel
  /** `Cluenori · Down`. */
  readonly title: string
  /** `Its health check failed twice, a minute apart: HTTP 503.` */
  readonly body: string
  /** The outage's issue, which Telegram and email link to; absent for a test. */
  readonly link: Option.Option<string>
  /**
   * The UUID the phone's alarm rings under: the outage's, so its Recovered stops the alarm; a
   * test's own.
   */
  readonly alert: string
  /** When it happened. */
  readonly at: DateTime.Utc
}

/** `14:05 UTC`: alerts say times in UTC, whatever the machine's time zone. */
export const timeText = (at: DateTime.Utc) => {
  const parts = DateTime.toPartsUtc(at)
  const two = (value: number) => String(value).padStart(2, "0")
  return `${two(parts.hour)}:${two(parts.minute)} UTC`
}

/** `1 h 5 min`, `12 min`, or `less than a minute`. */
export const durationText = (duration: Duration.Duration) => {
  const minutes = Math.floor(Duration.toMinutes(duration))
  if (minutes < 1) {
    return "less than a minute"
  }
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours === 0) {
    return `${rest} min`
  }
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`
}

/** The alert when two checks a minute apart failed. */
export const downAlert = (input: {
  readonly reason: string
  readonly alert: string
  readonly at: DateTime.Utc
  readonly link: string
}): Alert => ({
  level: "alarm",
  title: "Cluenori · Down",
  body: `Its health check failed twice, a minute apart: ${input.reason}.`,
  link: Option.some(input.link),
  alert: input.alert,
  at: input.at,
})

/** The hourly reminder while it stays down: time sensitive, not an alarm, so it doesn't ring all night. */
export const reminderAlert = (input: {
  readonly reason: string
  readonly alert: string
  readonly since: DateTime.Utc
  readonly at: DateTime.Utc
  readonly link: string
}): Alert => ({
  level: "timeSensitive",
  title: "Cluenori · Still down",
  body: `Down for ${durationText(DateTime.distance(input.since, input.at))}, since ${timeText(input.since)}: ${input.reason}.`,
  link: Option.some(input.link),
  alert: input.alert,
  at: input.at,
})

/** The one alert when it answers again: quiet, and under the outage's UUID, so it stops the alarm. */
export const recoveredAlert = (input: {
  readonly alert: string
  readonly since: DateTime.Utc
  readonly at: DateTime.Utc
  readonly link: string
}): Alert => ({
  level: "quiet",
  title: "Cluenori · Recovered",
  body: `Answering again after ${durationText(DateTime.distance(input.since, input.at))} down, since ${timeText(input.since)}.`,
  link: Option.some(input.link),
  alert: input.alert,
  at: input.at,
})

/** What a test sends: an alarm, so a phone rings as it would for Down. */
export const testAlert = (input: { readonly alert: string; readonly at: DateTime.Utc }): Alert => ({
  level: "alarm",
  title: "Cluenori watch · Test",
  body: "This is how Cluenori being down reaches you. Nothing is wrong.",
  link: Option.none(),
  alert: input.alert,
  at: input.at,
})
