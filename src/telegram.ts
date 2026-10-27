import { Duration, Effect, Option, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

import type { Alert } from "./alert.ts"
import type { Configured } from "./channel.ts"
import { ChannelFailed, secret } from "./channel.ts"

// Telegram's Bot API answers within this, or the send failed.
const answerTimeout = Duration.seconds(10)

const TelegramAnswer = Schema.Struct({ ok: Schema.Boolean, description: Schema.optionalKey(Schema.String) })
const decodeAnswer = Schema.decodeUnknownEffect(Schema.fromJsonString(TelegramAnswer))

/** The text of `alert` in a chat: its title, its words, and the outage's issue. */
export const telegramText = (alert: Alert) => [alert.title, alert.body, ...Option.toArray(alert.link)].join("\n")

/**
 * The Bot API's `sendMessage` for `alert`: plain text, so nothing in it needs escaping; quiet
 * alerts arrive without a sound, as on the phone.
 */
export const telegramMessage = (chatId: string, alert: Alert) => ({
  chat_id: chatId,
  text: telegramText(alert),
  disable_notification: alert.level === "quiet",
  link_preview_options: { is_disabled: true },
})

/**
 * Telegram, from `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Only sends: it never reads the bot's
 * updates or sets its webhook, so the same bot can later also be a client of Cluenori's own
 * notifications, which would own its updates.
 */
export const telegram = Effect.gen(function* () {
  const token = yield* secret("TELEGRAM_BOT_TOKEN")
  const chatId = yield* secret("TELEGRAM_CHAT_ID")
  const name = "Telegram"
  const secrets = [...Option.toArray(token), ...Option.toArray(chatId)]
  if (Option.isNone(token) && Option.isNone(chatId)) {
    return { _tag: "Off", name, needs: "TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" } satisfies Configured
  }
  if (Option.isNone(token) || Option.isNone(chatId)) {
    const missing = Option.isNone(token) ? "TELEGRAM_BOT_TOKEN" : "TELEGRAM_CHAT_ID"
    return { _tag: "Misconfigured", name, reason: `${missing} is missing`, secrets } satisfies Configured
  }
  const client = yield* HttpClient.HttpClient
  const url = `https://api.telegram.org/bot${token.value}/sendMessage`
  const configured: Configured = {
    _tag: "On",
    secrets,
    channel: {
      name,
      preview: (alert) => [`POST ${url}`, JSON.stringify(telegramMessage(chatId.value, alert), null, 2)],
      send: (alert) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(url),
            telegramMessage(chatId.value, alert),
          ).pipe(Effect.orDie)
          const response = yield* client.execute(request)
          const body = yield* response.text
          const answer = yield* decodeAnswer(body).pipe(Effect.option)
          if (response.status === 200 && Option.isSome(answer) && answer.value.ok) {
            return "delivered"
          }
          const description = Option.flatMap(answer, (each) => Option.fromUndefinedOr(each.description))
          return yield* new ChannelFailed({
            delivery: "refused",
            reason: `HTTP ${response.status}${Option.match(description, { onNone: () => "", onSome: (text) => `: ${text}` })}`,
          })
        }).pipe(
          Effect.timeout(answerTimeout),
          Effect.catchTags({
            // Telegram may have taken it: sending it again could say it twice.
            TimeoutError: () =>
              Effect.fail(new ChannelFailed({ delivery: "unknown", reason: "Telegram didn't answer in 10 s" })),
            HttpClientError: () =>
              Effect.fail(new ChannelFailed({ delivery: "unknown", reason: "no answer from Telegram" })),
          }),
        ),
    },
  }
  return configured
}).pipe(Effect.catchTag("ConfigError", Effect.die))
