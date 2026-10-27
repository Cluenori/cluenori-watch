import { appendFileSync } from "node:fs"

import { Crypto, Effect, Layer, Option } from "effect"
import { FetchHttpClient } from "effect/http"

import { program } from "./run.ts"

// Web Crypto, Node's own, for the alerts' UUIDs; fetch, which speaks HTTP/2 on Node 26, as APNs needs.
const CryptoLive = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(() => globalThis.crypto.subtle.digest(algorithm, new Uint8Array(data))).pipe(
        Effect.map((buffer) => new Uint8Array(buffer)),
      ),
  }),
)

const outcome = await Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(FetchHttpClient.layer, CryptoLive))),
)
if (Option.isSome(outcome.summaryFile)) {
  appendFileSync(outcome.summaryFile.value, outcome.summary)
}
process.exitCode = outcome.failed ? 1 : 0
