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
 * Cluenori writes: one channel for each phone. Reaches the phones without Cloudflare or Cluenori:
 * APNs is Apple's.
 */
export const apns = Effect.gen(function* () {
  const keyText = yield* secret("CLUENORI_APNS_KEY")
  const phonesText = yield* secret("CLUENORI_PHONES")
  const name = "APNs"
  if (Option.isNone(keyText) && Option.isNone(phonesText)) {
    return [
      {
        _tag: "Off",
        name,
        needs: "CLUENORI_APNS_KEY and CLUENORI_PHONES, which Cluenori writes once an owner names this repository",
      } satisfies Configured,
    ]
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
    return [{ _tag: "Misconfigured", name, reason: problem ?? "unreadable", secrets } satisfies Configured]
  }
  if (phones.value.phones.length === 0) {
    return [
      {
        _tag: "Misconfigured",
        name,
        reason: "no owner's phone has notifications on in Cluenori's iPhone app",
        secrets,
      } satisfies Configured,
    ]
  }
  const { keyId, teamId, topic } = key.value
  // Built once for the run, in its scope: a key that can't sign is found now, before any alert.
  const built = yield* Layer.build(
    Apns.layer({ key: Redacted.make(key.value.key), keyId, teamId }, globalThis.crypto.subtle),
  ).pipe(Effect.result)
  if (built._tag === "Failure") {
    return [
      {
        _tag: "Misconfigured",
        name,
        reason: `the APNs key in CLUENORI_APNS_KEY can't sign: ${built.failure.reason}`,
        secrets,
      } satisfies Configured,
    ]
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
  // Each phone is a channel of its own, so one that didn't take an alert is sent it again alone. It
  // is named by its token's SHA-256, which says nothing of the token, as the public issue records
  // channels by name; the whole of it, so two phones never share a name.
  return yield* Effect.forEach(phones.value.phones, (phone) =>
    Effect.gen(function* () {
      const digest = yield* Effect.promise(() =>
        globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(phone.token)),
      )
      const id = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
      const configured: Configured = {
        _tag: "On",
        secrets,
        channel: {
          name: `APNs phone ${id}`,
          preview: (alert) => {
            const push = pushOf(alert, phone)
            return [
              `POST https://${phone.environment === "production" ? "api.push.apple.com" : "api.sandbox.push.apple.com"}/3/device/${phone.token}`,
              `apns-topic: ${topic}, apns-push-type: alert, apns-priority: ${push.priority}, apns-collapse-id: ${alert.alert}, apns-expiration: ${DateTime.formatIso(DateTime.addDuration(alert.at, keptByApns))}`,
              JSON.stringify(push.payload, null, 2),
            ]
          },
          send: (alert) =>
            Effect.gen(function* () {
              const answer = yield* sender.send(pushOf(alert, phone)).pipe(Effect.result)
              if (answer._tag === "Failure") {
                const failure = answer.failure
                if (failure._tag === "ApnsCredentialsRefused") {
                  return yield* new ChannelFailed({
                    delivery: "refused",
                    reason: `APNs refused the key: ${failure.reason}`,
                  })
                }
                // APNs's own answer (too many requests, a server error) means it didn't take it; no
                // answer means it may have.
                return yield* new ChannelFailed({
                  delivery: failure.reason.startsWith("APNs answered") ? "refused" : "unknown",
                  reason: `APNs didn't take it: ${failure.reason}`,
                })
              }
              switch (answer.success._tag) {
                case "Accepted":
                  return `accepted (${phone.environment})`
                case "Inactive":
                  return yield* new ChannelFailed({
                    delivery: "final",
                    reason: "no longer registered; Cluenori forgets it on its next push",
                  })
                case "Rejected":
                  return yield* new ChannelFailed({ delivery: "final", reason: answer.success.reason })
              }
            }),
        },
      }
      return configured
    }),
  )
}).pipe(Effect.catchTag("ConfigError", Effect.die))
