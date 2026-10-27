import type { Effect } from "effect"
import { Config, Option, Schema } from "effect"

import type { Alert } from "./alert.ts"

/**
 * A channel couldn't deliver an alert: why, in the service's own words, which may echo what was
 * sent, so the run redacts and shortens them before showing them anywhere; and what is known of
 * it. `refused`: it definitely didn't arrive, and may later, so it is sent again. `unknown`: it may
 * have arrived (no answer, or none that could be read), so it is never sent again. `final`: it
 * never will, as for a phone without the app, so it isn't sent again either.
 */
export class ChannelFailed extends Schema.TaggedError<ChannelFailed>()("ChannelFailed", {
  reason: Schema.String,
  delivery: Schema.Literals(["refused", "unknown", "final"]),
}) {}

/** One way an alert reaches the founder: APNs to one phone with Cluenori's iPhone app, Telegram, or email. */
export interface Channel {
  readonly name: string
  /**
   * Exactly what `send` would send for `alert`: each request's method, address and body, with
   * secrets as they are (the report masks them).
   */
  readonly preview: (alert: Alert) => ReadonlyArray<string>
  /** Sends `alert`, saying what took it: `accepted`, `delivered`. Never fails another channel. */
  readonly send: (alert: Alert) => Effect.Effect<string, ChannelFailed>
}

/**
 * A channel as its secrets set it up: off when none of them exists, misconfigured when some do and
 * others don't or don't read, else on. `secrets` are the values to mask, whichever it is.
 */
export type Configured =
  | { readonly _tag: "Off"; readonly name: string; readonly needs: string }
  | {
      readonly _tag: "Misconfigured"
      readonly name: string
      readonly reason: string
      readonly secrets: ReadonlyArray<string>
    }
  | { readonly _tag: "On"; readonly channel: Channel; readonly secrets: ReadonlyArray<string> }

/** The values of `configured` to mask. */
export const secretsOf = (configured: Configured) => (configured._tag === "Off" ? [] : configured.secrets)

/**
 * A secret from the environment, absent when unset or empty: a workflow passes a repository
 * secret that doesn't exist as an empty string.
 */
export const secret = (name: string) =>
  Config.option(Config.String(name)).pipe(Config.map(Option.filter((value) => value.trim() !== "")))

/**
 * At most this much of a service's own words goes into the report. Shorten only redacted text: a
 * cut can split a secret, and the part left wouldn't be masked.
 */
export const reasonText = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}…` : text)
