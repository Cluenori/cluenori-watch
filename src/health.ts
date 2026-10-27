import { Duration, Effect, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"

import type { Health } from "./outage.ts"

/** A check that hasn't answered in this long failed. */
export const checkTimeout = Duration.seconds(10)

// A code the runtime gives a connection's failure, `ENOTFOUND` or `UND_ERR_CONNECT_TIMEOUT`: a word
// of its own, never the host, which the deployment's URL is, and the URL is a secret.
const codeOf = (error: unknown): string | undefined => {
  let current: unknown = error
  for (let depth = 0; depth < 6 && typeof current === "object" && current !== null; depth++) {
    const code: unknown = Reflect.get(current, "code")
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) {
      return code
    }
    current = Reflect.get(current, "cause")
  }
  return undefined
}

/**
 * Asks `<deployment>/api/health` once: up for a 2xx answer, down for any other status (a redirect
 * included), no answer within 10 s, or no connection. Never says the URL, which is a secret.
 */
export const checkHealth = Effect.fn("checkHealth")(function* (deployment: Redacted.Redacted<string>) {
  const client = yield* HttpClient.HttpClient
  const url = `${Redacted.value(deployment).replace(/\/+$/, "")}/api/health`
  return yield* client.get(url).pipe(
    Effect.flatMap((response) =>
      // The answer is read whole, so its connection is free, within the same 10 s.
      Effect.as(
        Effect.ignore(response.text),
        response.status >= 200 && response.status < 300
          ? ({ _tag: "Up", status: response.status } satisfies Health)
          : ({ _tag: "Down", reason: `HTTP ${response.status}` } satisfies Health),
      ),
    ),
    Effect.timeout(checkTimeout),
    Effect.catchTags({
      TimeoutError: () => Effect.succeed<Health>({ _tag: "Down", reason: "no answer in 10 s" }),
      HttpClientError: (error) => {
        const code = codeOf(error)
        return Effect.succeed<Health>({
          _tag: "Down",
          reason: code === undefined ? "couldn't connect" : `couldn't connect (${code})`,
        })
      },
    }),
    // A redirect is an answer that isn't 2xx: followed, it could end on any page that answers 200.
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
  )
})
