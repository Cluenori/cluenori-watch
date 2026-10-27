import type { ApnsPush } from "@bagatka/apns"
import { Apns, DeviceToken } from "@bagatka/apns"
import { Context, DateTime, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"

import type { Alert } from "./alert.ts"
import type { Configured } from "./channel.ts"
import { ChannelFailed, secret } from "./channel.ts"

/**
 * `CLUENORI_APNS_KEY`, which Cluenori writes when an owner names this repository: the APNs key its
 * own alerts are sent with, its IDs, and the bundle ID of Cluenori's iPhone app.
 */
export const ApnsKey = Schema.Struct({
  keyId: Schema.String,
  teamId: Schema.String,
  topic: Schema.String,
  key: Schema.String,
})

/**
 * `CLUENORI_PHONES`, which Cluenori writes whenever its owners' phones change: each owner's phone
 * that has notifications on, by its push token and APNs environment, and when it was written.
 */
export const ApnsPhones = Schema.Struct({
  writtenAt: Schema.DateTimeUtcFromString,
  phones: Schema.Array(
    Schema.Struct({ token: DeviceToken, environment: Schema.Literals(["development", "production"]) }),
  ),
})

const decodeKey = Schema.decodeUnknownEffect(Schema.fromJsonString(ApnsKey))
const decodePhones = Schema.decodeUnknownEffect(Schema.fromJsonString(ApnsPhones))

// APNs keeps a push for a phone that is off this long, then drops it: an alert later than this is
// about the past.
const keptByApns = Duration.hours(1)

/**
 * The payload Cluenori's app reads, as Cluenori's own test alarm has it: the notification
 * extension rings an alarm less than 10 minutes old, under `cluenori.alert`, and stops it when a
 * quiet push with the same `alert` comes. No incident: Acknowledge on the alarm only stops it.
 */
export const apnsPayload = (alert: Alert) => ({
  aps: {
    alert: { title: alert.title, body: alert.body },
    "interruption-level": alert.level === "quiet" ? "passive" : "time-sensitive",
    // An alarm rings on its own; its notification is silent.
    ...(alert.level === "timeSensitive" ? { sound: "default" } : {}),
    "thread-id": "cluenori-watch",
    "mutable-content": 1,
  },
  cluenori: { level: alert.level, at: DateTime.formatIso(alert.at), alert: alert.alert },
})

/**
 * Cluenori's iPhone app, through APNs, from `CLUENORI_APNS_KEY` and `CLUENORI_PHONES`, which
 * Cluenori writes. Reaches the phones without Cloudflare or Cluenori: APNs is Apple's.
 */
export const apns = Effect.gen(function* () {
  const keyText = yield* secret("CLUENORI_APNS_KEY")
  const phonesText = yield* secret("CLUENORI_PHONES")
  const name = "APNs"
  if (Option.isNone(keyText) && Option.isNone(phonesText)) {
    return {
      _tag: "Off",
      name,
      needs: "CLUENORI_APNS_KEY and CLUENORI_PHONES, which Cluenori writes once an owner names this repository",
    } satisfies Configured
  }
  // The phones' tokens and the key's lines are masked one by one: GitHub masks only each secret whole.
  const key = yield* Option.match(keyText, {
    onNone: () => Effect.succeedNone,
    onSome: (text) => decodeKey(text).pipe(Effect.option),
  })
  const phones = yield* Option.match(phonesText, {
    onNone: () => Effect.succeedNone,
    onSome: (text) => decodePhones(text).pipe(Effect.option),
  })
  const secrets = [
    ...Option.toArray(keyText),
    ...Option.toArray(phonesText),
    ...Option.toArray(key).flatMap((each) => [each.key, each.keyId, each.teamId, each.topic]),
    ...Option.toArray(phones).flatMap((each) => each.phones.map((phone) => phone.token)),
  ]
  const problem = Option.isNone(keyText)
    ? "CLUENORI_APNS_KEY is missing: name this repository in Cluenori again"
    : Option.isNone(phonesText)
      ? "CLUENORI_PHONES is missing: turn notifications on in Cluenori's iPhone app"
      : Option.isNone(key)
        ? "CLUENORI_APNS_KEY isn't the key Cluenori writes"
        : Option.isNone(phones)
          ? "CLUENORI_PHONES isn't the list Cluenori writes"
          : undefined
  if (problem !== undefined || Option.isNone(key) || Option.isNone(phones)) {
    return { _tag: "Misconfigured", name, reason: problem ?? "unreadable", secrets } satisfies Configured
  }
  if (phones.value.phones.length === 0) {
    return {
      _tag: "Misconfigured",
      name,
      reason: "no owner's phone has notifications on in Cluenori's iPhone app",
      secrets,
    } satisfies Configured
  }
  const { keyId, teamId, topic } = key.value
  // Built once for the run, in its scope: a key that can't sign is found now, before any alert.
  const built = yield* Layer.build(
    Apns.layer({ key: Redacted.make(key.value.key), keyId, teamId }, globalThis.crypto.subtle),
  ).pipe(Effect.result)
  if (built._tag === "Failure") {
    return {
      _tag: "Misconfigured",
      name,
      reason: `the APNs key in CLUENORI_APNS_KEY can't sign: ${built.failure.reason}`,
      secrets,
    } satisfies Configured
  }
  const sender = Context.get(built.success, Apns)
  const pushOf = (alert: Alert, phone: (typeof phones.value.phones)[number]): ApnsPush => ({
    deviceToken: phone.token,
    environment: phone.environment,
    bundleId: topic,
    pushType: "alert",
    priority: alert.level === "quiet" ? 5 : 10,
    payload: apnsPayload(alert),
    collapseId: alert.alert,
    expiresAt: DateTime.addDuration(alert.at, keptByApns),
  })
  const count = (n: number) => (n === 1 ? "1 phone" : `${n} phones`)
  const configured: Configured = {
    _tag: "On",
    secrets,
    channel: {
      name,
      preview: (alert) =>
        phones.value.phones.flatMap((phone, index) => {
          const push = pushOf(alert, phone)
          return [
            `POST https://${phone.environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"}/3/device/${phone.token} (phone ${index + 1})`,
            `apns-topic: ${topic}, apns-push-type: alert, apns-priority: ${push.priority}, apns-collapse-id: ${alert.alert}, apns-expiration: ${DateTime.formatIso(DateTime.addDuration(alert.at, keptByApns))}`,
            JSON.stringify(push.payload, null, 2),
          ]
        }),
      send: (alert) =>
        Effect.gen(function* () {
          const problems: Array<string> = []
          let accepted = 0
          for (const [index, phone] of phones.value.phones.entries()) {
            const answer = yield* sender.send(pushOf(alert, phone)).pipe(Effect.result)
            const which = `phone ${index + 1} (${phone.environment})`
            if (answer._tag === "Failure") {
              const failure = answer.failure
              if (failure._tag === "ApnsCredentialsRefused") {
                return yield* new ChannelFailed({ reason: `APNs refused the key: ${failure.reason}` })
              }
              problems.push(`${which}: APNs didn't take it (${failure.reason})`)
            } else if (answer.success._tag === "Accepted") {
              accepted++
            } else if (answer.success._tag === "Inactive") {
              problems.push(`${which}: no longer registered; Cluenori forgets it on its next push`)
            } else {
              problems.push(`${which}: ${answer.success.reason}`)
            }
          }
          const total = phones.value.phones.length
          if (accepted === 0) {
            return yield* new ChannelFailed({ reason: `no phone took it: ${problems.join("; ")}` })
          }
          return problems.length === 0 ? count(accepted) : `${accepted} of ${count(total)}; ${problems.join("; ")}`
        }),
    },
  }
  return configured
}).pipe(Effect.catchTag("ConfigError", Effect.die))
