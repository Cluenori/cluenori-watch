import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

import type { Alert } from "./alert.ts"
import type { Configured } from "./channel.ts"
import { ChannelFailed, secret } from "./channel.ts"

// Cloudflare's API answers within this, or the send failed.
const answerTimeout = Duration.seconds(15)

// Cloudflare's answer: `success`, its errors' messages (`email.sending.error.email.sending_not_ready`),
// and which recipients took it now, later, or bounced.
const EmailAnswer = Schema.Struct({
  success: Schema.Boolean,
  errors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ code: Schema.optionalKey(Schema.Finite), message: Schema.optionalKey(Schema.String) }),
    ),
  ),
  result: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        delivered: Schema.optionalKey(Schema.Array(Schema.String)),
        queued: Schema.optionalKey(Schema.Array(Schema.String)),
        permanent_bounces: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
})
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(EmailAnswer))

/** The email for `alert`: its title as the subject, its words and the outage's issue as plain text. */
export const emailMessage = (from: string, to: string, alert: Alert) => ({
  from,
  to,
  subject: alert.title,
  text: [alert.body, ...Option.toArray(alert.link)].join("\n\n"),
})

/**
 * Email through Cloudflare Email Sending's REST API, from `CLOUDFLARE_ACCOUNT_ID`,
 * `CLOUDFLARE_EMAIL_TOKEN` (an API token with Email Sending: Edit), `EMAIL_FROM` (an address on a
 * domain onboarded for Email Sending) and `EMAIL_TO`.
 */
export const email = Effect.gen(function* () {
  const values = {
    CLOUDFLARE_ACCOUNT_ID: yield* secret("CLOUDFLARE_ACCOUNT_ID"),
    CLOUDFLARE_EMAIL_TOKEN: yield* secret("CLOUDFLARE_EMAIL_TOKEN"),
    EMAIL_FROM: yield* secret("EMAIL_FROM"),
    EMAIL_TO: yield* secret("EMAIL_TO"),
  }
  const name = "Email"
  const entries = Object.entries(values)
  const secrets = entries.flatMap(([, value]) => Option.toArray(value))
  if (secrets.length === 0) {
    return { _tag: "Off", name, needs: entries.map(([key]) => key).join(", ") } satisfies Configured
  }
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_EMAIL_TOKEN: token, EMAIL_FROM: from, EMAIL_TO: to } = values
  if (Option.isNone(account) || Option.isNone(token) || Option.isNone(from) || Option.isNone(to)) {
    const missing = entries.filter(([, value]) => Option.isNone(value)).map(([key]) => key)
    return { _tag: "Misconfigured", name, reason: `${missing.join(", ")} missing`, secrets } satisfies Configured
  }
  const client = yield* HttpClient.HttpClient
  const url = `https://api.cloudflare.com/client/v4/accounts/${account.value}/email/sending/send`
  const configured: Configured = {
    _tag: "On",
    secrets,
    channel: {
      name,
      preview: (alert) => [
        `POST ${url}`,
        `authorization: Bearer ${token.value}`,
        JSON.stringify(emailMessage(from.value, to.value, alert), null, 2),
      ],
      send: (alert) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.bearerToken(HttpClientRequest.post(url), token.value),
            emailMessage(from.value, to.value, alert),
          ).pipe(Effect.orDie)
          const response = yield* client.execute(request)
          const answer = yield* decodeAnswer(yield* response.text).pipe(Effect.option)
          if (Option.isNone(answer)) {
            return yield* new ChannelFailed({
              delivery: "unknown",
              reason: `HTTP ${response.status}, an answer that isn't Cloudflare's`,
            })
          }
          const result = answer.value.result ?? null
          const bounced = result?.permanent_bounces ?? []
          if (response.status === 200 && answer.value.success && bounced.length === 0) {
            return (result?.queued ?? []).length > 0 ? "queued" : "delivered"
          }
          const messages = (answer.value.errors ?? []).flatMap((error) =>
            error.message === undefined ? [] : [error.message],
          )
          const why = bounced.length > 0 ? "the address bounced" : messages.join(", ")
          return yield* new ChannelFailed({
            // A 200 that doesn't say it worked may have: only an error status says it didn't.
            delivery: bounced.length > 0 ? "final" : response.status === 200 ? "unknown" : "refused",
            reason: `HTTP ${response.status}${why === "" ? "" : `: ${why}`}`,
          })
        }).pipe(
          Effect.timeout(answerTimeout),
          Effect.catchTags({
            // Cloudflare may have taken it: sending it again could send it twice.
            TimeoutError: () =>
              Effect.fail(new ChannelFailed({ delivery: "unknown", reason: "Cloudflare didn't answer in 15 s" })),
            HttpClientError: () =>
              Effect.fail(new ChannelFailed({ delivery: "unknown", reason: "no answer from Cloudflare" })),
          }),
        ),
    },
  }
  return configured
}).pipe(Effect.catchTag("ConfigError", Effect.die))
