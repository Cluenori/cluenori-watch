import { assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Crypto, Effect, Fiber, Layer, Schema } from "effect"
import { Base64 } from "effect/encoding"
import { HttpClient, HttpClientResponse } from "effect/http"
import { TestClock } from "effect/testing"

import { program } from "../src/run.ts"

// 2026-10-27T10:02:00Z, a run's time.
const start = 1793095320000

const deployment = "https://watched.example.net"
const botToken = "123456789:AAH-telegram-bot-token-for-tests"
const chatId = "424242424242"
const cfToken = "cloudflare-email-token-for-tests"
const account = "0123456789abcdef0123456789abcdef"
const phoneToken = "ab".repeat(32)
const oldPhoneToken = "cd".repeat(32)

interface Issue {
  readonly number: number
  state: "open" | "closed"
  body: string
  readonly labels: ReadonlyArray<string>
  readonly comments: Array<string>
}

/** Everything the run talks to, faked, and what each was sent. */
interface World {
  /** What each health check answers, in turn; the last one again once they run out. */
  health: Array<number>
  readonly issues: Array<Issue>
  /** What GitHub answers to opening an issue, when it doesn't open one. */
  openIssueStatus: number | undefined
  emailStatus: number
  readonly sent: {
    readonly telegram: Array<{ readonly text: string; readonly disable_notification: boolean }>
    readonly email: Array<{ readonly subject: string; readonly text: string }>
    readonly apns: Array<{
      readonly token: string
      readonly headers: Readonly<Record<string, string>>
      readonly payload: Payload
    }>
  }
}

const Payload = Schema.Struct({
  aps: Schema.Struct({
    alert: Schema.Struct({ title: Schema.String, body: Schema.String }),
    "interruption-level": Schema.String,
    "mutable-content": Schema.Finite,
    sound: Schema.optionalKey(Schema.String),
  }),
  cluenori: Schema.Struct({ level: Schema.String, at: Schema.String, alert: Schema.String }),
})
type Payload = typeof Payload.Type
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const decodePayload = Schema.decodeUnknownEffect(Payload)
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const newWorld = (): World => ({
  health: [204],
  issues: [],
  openIssueStatus: undefined,
  emailStatus: 200,
  sent: { telegram: [], email: [], apns: [] },
})

const issueJson = (issue: Issue) => ({
  number: issue.number,
  html_url: `https://github.com/Cluenori/cluenori-watch/issues/${issue.number}`,
  body: issue.body,
  labels: issue.labels.map((name) => ({ name })),
})

// The fake of every service the run calls: the deployment, GitHub's issues, Telegram, Cloudflare,
// and APNs, by host and path.
const fakeClient = (world: World) =>
  HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const text = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
      const body: Record<string, unknown> =
        text === "" ? {} : ((yield* decodeJson(text).pipe(Effect.orDie)) as Record<string, unknown>)
      const answer = (status: number, json?: unknown, headers: Record<string, string> = {}) =>
        Effect.gen(function* () {
          const encoded = json === undefined ? null : yield* encodeJson(json).pipe(Effect.orDie)
          return HttpClientResponse.fromWeb(
            request,
            new Response(encoded, { status, headers: { "content-type": "application/json", ...headers } }),
          )
        })
      const path = url.pathname
      if (url.origin === deployment && path === "/api/health") {
        const status = world.health.length > 1 ? (world.health.shift() ?? 204) : (world.health[0] ?? 204)
        return yield* answer(status)
      }
      if (url.origin === "https://api.github.com") {
        const issues = "/repos/Cluenori/cluenori-watch/issues"
        if (request.method === "GET" && path === issues) {
          assert.strictEqual(url.searchParams.get("labels"), "cluenori-down")
          return yield* answer(
            200,
            world.issues
              .filter((issue) => issue.state === "open" && issue.labels.includes("cluenori-down"))
              .map(issueJson),
          )
        }
        if (request.method === "POST" && path === "/repos/Cluenori/cluenori-watch/labels") {
          return yield* answer(world.issues.length === 0 ? 201 : 422, {})
        }
        if (request.method === "POST" && path === issues) {
          if (world.openIssueStatus !== undefined) {
            return yield* answer(world.openIssueStatus, { message: "Server Error" })
          }
          const issue: Issue = {
            number: world.issues.length + 1,
            state: "open",
            body: String(body["body"]),
            labels: body["labels"] as Array<string>,
            comments: [],
          }
          world.issues.push(issue)
          return yield* answer(201, issueJson(issue))
        }
        const one = /^\/repos\/Cluenori\/cluenori-watch\/issues\/(\d+)(\/comments)?$/.exec(path)
        const issue = world.issues.find((each) => each.number === Number(one?.[1]))
        if (issue !== undefined && one?.[2] === "/comments") {
          issue.comments.push(String(body["body"]))
          return yield* answer(201, {})
        }
        if (issue !== undefined && request.method === "PATCH") {
          if (typeof body["body"] === "string") {
            issue.body = body["body"]
          }
          if (body["state"] === "closed") {
            issue.state = "closed"
          }
          return yield* answer(200, issueJson(issue))
        }
      }
      if (url.origin === "https://api.telegram.org" && path === `/bot${botToken}/sendMessage`) {
        assert.strictEqual(body["chat_id"], chatId)
        world.sent.telegram.push({
          text: String(body["text"]),
          disable_notification: body["disable_notification"] === true,
        })
        return yield* answer(200, { ok: true, result: {} })
      }
      if (url.origin === "https://api.cloudflare.com" && path === `/client/v4/accounts/${account}/email/sending/send`) {
        assert.strictEqual(request.headers["authorization"], `Bearer ${cfToken}`)
        if (world.emailStatus !== 200) {
          return yield* answer(world.emailStatus, {
            success: false,
            errors: [{ code: 10002, message: "email.sending.error.internal_server" }],
            result: null,
          })
        }
        world.sent.email.push({ subject: String(body["subject"]), text: String(body["text"]) })
        return yield* answer(200, { success: true, errors: [], result: { delivered: ["founder@example.com"] } })
      }
      const device = /^\/3\/device\/([0-9a-f]+)$/.exec(path)
      if (url.origin === "https://api.push.apple.com" && device !== null) {
        const token = device[1] ?? ""
        if (token === oldPhoneToken) {
          return yield* answer(410, { reason: "Unregistered", timestamp: start })
        }
        world.sent.apns.push({
          token,
          headers: request.headers,
          payload: yield* decodePayload(body).pipe(Effect.orDie),
        })
        return yield* answer(200, undefined, { "apns-id": "00000000-0000-4000-8000-000000000001" })
      }
      return yield* Effect.die(`The run asked ${request.method} ${url.href}, which these tests don't fake`)
    }),
  )

// A key of the tests' own, as Apple's `.p8` file holds one.
const apnsKey = Effect.gen(function* () {
  const pair = yield* Effect.promise(() =>
    crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]),
  )
  const exported = yield* Effect.promise(() => crypto.subtle.exportKey("pkcs8", pair.privateKey))
  return `-----BEGIN PRIVATE KEY-----\n${Base64.encode(new Uint8Array(exported))}\n-----END PRIVATE KEY-----\n`
})

// The secrets as a workflow passes them, a channel that isn't set up as an empty string.
const secretsWith = Effect.fn("secretsWith")(function* (phones: ReadonlyArray<string> = [phoneToken]) {
  const key = yield* apnsKey
  const apns = yield* encodeJson({
    keyId: "ABCDE12345",
    teamId: "TEAM123456",
    topic: "com.example.cluenori",
    key,
  }).pipe(Effect.orDie)
  const list = yield* encodeJson({
    writtenAt: "2026-10-27T09:00:00.000Z",
    phones: phones.map((token) => ({ token, environment: "production" })),
  }).pipe(Effect.orDie)
  return {
    CLUENORI_URL: deployment,
    GITHUB_TOKEN: "ghs_github-token-for-tests",
    GITHUB_REPOSITORY: "Cluenori/cluenori-watch",
    GITHUB_RUN_ID: "1",
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_CHAT_ID: chatId,
    CLOUDFLARE_ACCOUNT_ID: account,
    CLOUDFLARE_EMAIL_TOKEN: cfToken,
    EMAIL_FROM: "watch@notify.example.net",
    EMAIL_TO: "founder@example.com",
    CLUENORI_APNS_KEY: apns,
    CLUENORI_PHONES: list,
  } as Record<string, string>
})

const testCrypto = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: () => Effect.die("not used"),
  }),
)

// One run, as the schedule starts it, at the test clock's time: it waits its minute when it needs a
// second check.
const runOnce = (world: World, env: Record<string, string>) =>
  Effect.gen(function* () {
    const fiber = yield* program.pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(HttpClient.HttpClient, fakeClient(world)),
          testCrypto,
          ConfigProvider.layer(ConfigProvider.fromUnknown(env)),
        ),
      ),
      Effect.forkChild,
    )
    yield* TestClock.adjust("1 minute")
    return yield* Fiber.join(fiber)
  })

const sentCount = (world: World) => world.sent.telegram.length + world.sent.email.length + world.sent.apns.length

describe("watching the deployment", () => {
  it.effect("alerts once when it goes down, reminds hourly, and says Recovered once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const world = newWorld()
      const env = yield* secretsWith()

      const up = yield* runOnce(world, env)
      assert.isFalse(up.failed)
      assert.strictEqual(sentCount(world), 0)

      // One failed check, then one that answers: nothing is sent, nothing opens.
      world.health = [503, 204]
      yield* runOnce(world, env)
      assert.strictEqual(sentCount(world), 0)
      assert.strictEqual(world.issues.length, 0)

      // Two checks a minute apart fail: Down, through every channel, and an issue opens.
      world.health = [503]
      const down = yield* runOnce(world, env)
      assert.isFalse(down.failed, down.summary)
      assert.strictEqual(world.issues.length, 1)
      const issue = world.issues[0]
      assert.strictEqual(issue?.state, "open")
      assert.deepStrictEqual(issue?.labels, ["cluenori-down"])
      assert.strictEqual(world.sent.telegram.length, 1)
      assert.strictEqual(world.sent.email.length, 1)
      assert.strictEqual(world.sent.apns.length, 1)
      const alarm = world.sent.apns[0]
      assert.strictEqual(alarm?.payload.cluenori.level, "alarm")
      assert.strictEqual(alarm?.payload.aps.alert.title, "Cluenori · Down")
      assert.strictEqual(alarm?.payload.aps.alert.body, "Its health check failed twice, a minute apart: HTTP 503.")
      assert.strictEqual(alarm?.headers["apns-priority"], "10")
      assert.strictEqual(alarm?.headers["apns-collapse-id"], alarm?.payload.cluenori.alert)
      assert.include(world.sent.telegram[0]?.text ?? "", "https://github.com/Cluenori/cluenori-watch/issues/1")
      assert.strictEqual(world.sent.email[0]?.subject, "Cluenori · Down")
      assert.include(issue?.comments[0] ?? "", "Telegram: sent")

      // Every five minutes within the hour: nothing more.
      for (let run = 0; run < 10; run++) {
        yield* TestClock.adjust("4 minutes")
        yield* runOnce(world, env)
      }
      assert.strictEqual(sentCount(world), 3)

      // An answer between failures changes nothing, not even the reminder's time.
      world.health = [204, 503]
      yield* runOnce(world, env)
      assert.strictEqual(sentCount(world), 3)
      assert.strictEqual(issue?.state, "open")

      // An hour after Down: one reminder, time sensitive, under the same alert.
      world.health = [503]
      yield* TestClock.adjust("10 minutes")
      yield* runOnce(world, env)
      assert.strictEqual(world.sent.apns.length, 2)
      const reminder = world.sent.apns[1]
      assert.strictEqual(reminder?.payload.cluenori.level, "timeSensitive")
      assert.strictEqual(reminder?.payload.aps.sound, "default")
      assert.strictEqual(reminder?.payload.cluenori.alert, alarm?.payload.cluenori.alert)
      assert.match(reminder?.payload.aps.alert.body ?? "", /^Down for 1 h( \d+ min)?, since 10:0\d UTC: HTTP 503\.$/)
      yield* TestClock.adjust("4 minutes")
      yield* runOnce(world, env)
      assert.strictEqual(world.sent.apns.length, 2)

      // Two answers a minute apart: Recovered, once, quiet, which stops the alarm; the issue closes.
      world.health = [204]
      yield* TestClock.adjust("4 minutes")
      yield* runOnce(world, env)
      assert.strictEqual(issue?.state, "closed")
      assert.strictEqual(world.sent.apns.length, 3)
      const recovered = world.sent.apns[2]
      assert.strictEqual(recovered?.payload.cluenori.level, "quiet")
      assert.strictEqual(recovered?.payload.aps["interruption-level"], "passive")
      assert.strictEqual(recovered?.payload.cluenori.alert, alarm?.payload.cluenori.alert)
      assert.isTrue(world.sent.telegram[2]?.disable_notification)
      for (let run = 0; run < 3; run++) {
        yield* TestClock.adjust("4 minutes")
        yield* runOnce(world, env)
      }
      assert.strictEqual(world.sent.apns.length, 3)
      assert.strictEqual(world.sent.telegram.length, 3)
    }),
  )

  it.effect("sends through the other channels when one fails, and fails the run", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const world = newWorld()
      world.health = [503]
      world.emailStatus = 500
      const down = yield* runOnce(world, yield* secretsWith())
      assert.isTrue(down.failed)
      assert.strictEqual(world.sent.telegram.length, 1)
      assert.strictEqual(world.sent.apns.length, 1)
      assert.include(down.summary, "Email couldn't send")
      assert.include(down.summary, "email.sending.error.internal_server")
      assert.include(world.issues[0]?.comments[0] ?? "", "Email: failed")
    }),
  )

  it.effect("sends nothing when the issue can't be opened, so the next run doesn't send Down twice", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const world = newWorld()
      world.health = [503]
      world.openIssueStatus = 500
      const down = yield* runOnce(world, yield* secretsWith())
      assert.isTrue(down.failed)
      assert.strictEqual(sentCount(world), 0)
    }),
  )

  it.effect("ignores an issue a stranger opens, which has no label", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const world = newWorld()
      world.issues.push({ number: 1, state: "open", body: "Cluenori is down!", labels: [], comments: [] })
      const up = yield* runOnce(world, yield* secretsWith())
      assert.isFalse(up.failed)
      assert.strictEqual(sentCount(world), 0)
      assert.strictEqual(world.issues[0]?.state, "open")
    }),
  )

  it.effect("reaches the phones that still have the app, and says which one doesn't", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const world = newWorld()
      world.health = [503]
      const down = yield* runOnce(world, yield* secretsWith([oldPhoneToken, phoneToken]))
      assert.isFalse(down.failed, down.summary)
      assert.strictEqual(world.sent.apns.length, 1)
      assert.include(down.summary, "APNs: sent, 1 of 2 phones; phone 1 (production): no longer registered")
    }),
  )

  it.effect("keeps every secret out of the run's summary and the public issue", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(start)
      const world = newWorld()
      world.health = [503]
      world.emailStatus = 500
      const env = yield* secretsWith([oldPhoneToken, phoneToken])
      const runs = [yield* runOnce(world, env), yield* runOnce(world, { ...env, DRY_RUN: "true", MODE: "test" })]
      const published = [
        ...runs.map((run) => run.summary),
        ...world.issues.flatMap((issue) => [issue.body, ...issue.comments]),
      ].join("\n")
      assert.include(published, "Telegram would send")
      const key = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ key: Schema.String })))(
        env["CLUENORI_APNS_KEY"],
      ).pipe(Effect.orDie)
      const secrets = [
        deployment,
        "watched.example.net",
        botToken,
        chatId,
        cfToken,
        account,
        phoneToken,
        oldPhoneToken,
        "founder@example.com",
        "watch@notify.example.net",
        ...key.key.split("\n").filter((line) => line.length > 20),
      ]
      for (const secret of secrets) {
        assert.notInclude(published, secret)
      }
    }),
  )
})
