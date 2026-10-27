import { DateTime, Duration, Effect, Redacted, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

import { timeText } from "./alert.ts"
import type { Outage } from "./outage.ts"
import { OutageState } from "./outage.ts"

/** The label that marks an outage's issue. */
export const outageLabel = "cluenori-down"

/**
 * Who opens an outage's issue: the workflow, with its `GITHUB_TOKEN`. Only an issue with the label
 * that this account opened is an outage, so an issue a stranger opens on this public repository is
 * never taken for one, even when a maintainer labels it.
 */
export const outageAuthor = "github-actions[bot]"

// GitHub answers within this, or the request failed.
const answerTimeout = Duration.seconds(15)

/** GitHub didn't do what was asked of the outage's issue, and why. */
export class IssuesFailed extends Schema.TaggedError<IssuesFailed>()("IssuesFailed", { reason: Schema.String }) {}

const Issue = Schema.Struct({
  number: Schema.Finite,
  html_url: Schema.String,
  body: Schema.NullOr(Schema.String),
  pull_request: Schema.optionalKey(Schema.Unknown),
  labels: Schema.Array(Schema.Struct({ name: Schema.String })),
  user: Schema.NullOr(Schema.Struct({ login: Schema.String })),
})
type Issue = typeof Issue.Type

// The state is the last thing in the issue's body, in a comment GitHub doesn't show.
const stateMarker = /<!-- cluenori-watch (\{.*\}) -->\s*$/
const encodeState = Schema.encodeEffect(Schema.fromJsonString(OutageState))
const decodeState = Schema.decodeEffect(Schema.fromJsonString(OutageState))

/** The body of an outage's issue: what happened, in words, and its state. */
const bodyOf = Effect.fn("bodyOf")(function* (state: OutageState) {
  const encoded = yield* encodeState(state).pipe(Effect.orDie)
  return [
    `Cluenori's health check failed twice, a minute apart, at ${timeText(state.since)}: ${state.reason}.`,
    "",
    `cluenori-watch reminds every hour while it stays down, and closes this issue once it answers again and Recovered reached every channel. Last alert: ${timeText(state.lastAlertAt)}.`,
    ...(state.recoveredAt === undefined ? [] : ["", `Answering again since ${timeText(state.recoveredAt)}.`]),
    "",
    `<!-- cluenori-watch ${encoded} -->`,
  ].join("\n")
})

/**
 * The outage's issue on GitHub: open it, find it, record its state, close it. Everything written
 * passes through `redact` first: the repository is public.
 */
export interface Issues {
  /**
   * The open outages, oldest first, at most 10: open issues with the outage's label that the
   * workflow opened. At most one is down; others recovered and are still sending Recovered.
   */
  readonly open: Effect.Effect<ReadonlyArray<Outage>, IssuesFailed>
  /** Opens an issue for a new outage, labelled, and returns it. */
  readonly openOutage: (state: OutageState) => Effect.Effect<Outage, IssuesFailed>
  /** Replaces the issue's state with `state`, and returns the outage as it now is. */
  readonly update: (outage: Outage, state: OutageState) => Effect.Effect<Outage, IssuesFailed>
  /** Adds `text` to the issue's conversation. */
  readonly comment: (outage: Outage, text: string) => Effect.Effect<void, IssuesFailed>
  /** Closes the issue, as completed. */
  readonly close: (outage: Outage) => Effect.Effect<void, IssuesFailed>
}

/**
 * The issues of `repository` (`owner/name`), with `token`, which may read and write them; `redact`
 * masks the secrets in every body and comment written.
 */
export const makeIssues = Effect.fn("makeIssues")(function* (input: {
  readonly api: string
  readonly repository: string
  readonly token: Redacted.Redacted<string>
  readonly redact: (text: string) => string
}) {
  const client = yield* HttpClient.HttpClient
  const base = `${input.api}/repos/${input.repository}`

  // One request to GitHub: its status and body, or why there was none.
  const ask = (
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: Record<string, unknown>,
  ): Effect.Effect<{ readonly status: number; readonly body: string }, IssuesFailed> =>
    Effect.gen(function* () {
      const request = HttpClientRequest.make(method)(`${base}${path}`).pipe(
        HttpClientRequest.bearerToken(Redacted.value(input.token)),
        HttpClientRequest.setHeaders({
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "cluenori-watch",
        }),
      )
      const withBody =
        body === undefined ? request : yield* HttpClientRequest.bodyJson(request, body).pipe(Effect.orDie)
      const response = yield* client.execute(withBody)
      return { status: response.status, body: yield* response.text }
    }).pipe(
      Effect.timeout(answerTimeout),
      Effect.catchTags({
        TimeoutError: () => Effect.fail(new IssuesFailed({ reason: `GitHub didn't answer ${method} ${path} in 15 s` })),
        HttpClientError: () => Effect.fail(new IssuesFailed({ reason: `couldn't reach GitHub for ${method} ${path}` })),
      }),
    )

  // An answer with `status`, its body decoded with `schema`, or a failure that says GitHub's status.
  const expect = <A>(
    answer: { readonly status: number; readonly body: string },
    status: number,
    what: string,
    schema: Schema.Decoder<A>,
  ) =>
    answer.status === status
      ? Schema.decodeEffect(Schema.fromJsonString(schema))(answer.body).pipe(
          Effect.mapError(() => new IssuesFailed({ reason: `GitHub's answer to ${what} isn't an issue's` })),
        )
      : Effect.fail(new IssuesFailed({ reason: `GitHub answered ${what} with HTTP ${answer.status}` }))

  const outageOf = Effect.fn("outageOf")(function* (issue: Issue) {
    const marked = stateMarker.exec(issue.body ?? "")?.[1]
    if (marked === undefined) {
      return yield* new IssuesFailed({
        reason: `issue #${issue.number} has the ${outageLabel} label but not cluenori-watch's state: close it, or put its state back`,
      })
    }
    const state = yield* decodeState(marked).pipe(
      Effect.mapError(
        () => new IssuesFailed({ reason: `issue #${issue.number}'s state isn't what cluenori-watch writes: close it` }),
      ),
    )
    const outage: Outage = { ...state, issue: issue.number, url: issue.html_url }
    return outage
  })

  const open = Effect.gen(function* () {
    // Asked of GitHub by author too, so others' issues never crowd the workflow's out of the page.
    const answer = yield* ask(
      "GET",
      `/issues?state=open&labels=${outageLabel}&creator=${encodeURIComponent(outageAuthor)}&sort=created&direction=asc&per_page=10`,
    )
    const issues = yield* expect(answer, 200, "the open outages", Schema.Array(Issue))
    const ours = issues.filter((issue) => issue.pull_request === undefined && issue.user?.login === outageAuthor)
    return yield* Effect.forEach(ours, outageOf)
  })

  const openOutage = Effect.fn("openOutage")(function* (state: OutageState) {
    // The label is made first, so the issue has it: GitHub drops a label it doesn't know, and an
    // outage without it would be opened again on every run. 422: it exists.
    const label = yield* ask("POST", "/labels", {
      name: outageLabel,
      color: "d73a49",
      description: "Cluenori is down: cluenori-watch opened this, and closes it once it answers again",
    })
    if (label.status !== 201 && label.status !== 422) {
      return yield* new IssuesFailed({
        reason: `GitHub answered making the ${outageLabel} label with HTTP ${label.status}`,
      })
    }
    const created = yield* ask("POST", "/issues", {
      title: `Cluenori is down since ${timeText(state.since)}`,
      body: input.redact(yield* bodyOf(state)),
      labels: [outageLabel],
    })
    const issue = yield* expect(created, 201, "opening the outage's issue", Issue)
    if (!issue.labels.some((each) => each.name === outageLabel)) {
      return yield* new IssuesFailed({
        reason: `GitHub opened issue #${issue.number} without the ${outageLabel} label`,
      })
    }
    return yield* outageOf(issue)
  })

  const update = Effect.fn("update")(function* (outage: Outage, state: OutageState) {
    const answer = yield* ask("PATCH", `/issues/${outage.issue}`, { body: input.redact(yield* bodyOf(state)) })
    yield* expect(answer, 200, "recording the outage's state", Issue)
    const updated: Outage = { ...state, issue: outage.issue, url: outage.url }
    return updated
  })

  const comment = Effect.fn("comment")(function* (outage: Outage, text: string) {
    const answer = yield* ask("POST", `/issues/${outage.issue}/comments`, { body: input.redact(text) })
    if (answer.status !== 201) {
      return yield* new IssuesFailed({
        reason: `GitHub answered a comment on #${outage.issue} with HTTP ${answer.status}`,
      })
    }
  })

  const close = Effect.fn("close")(function* (outage: Outage) {
    const answer = yield* ask("PATCH", `/issues/${outage.issue}`, { state: "closed", state_reason: "completed" })
    yield* expect(answer, 200, "closing the outage's issue", Issue)
  })

  const issues: Issues = { open, openOutage, update, comment, close }
  return issues
})

/** Today's date and time, `2026-10-27 14:05 UTC`, for a comment. */
export const stampText = (at: DateTime.Utc) => `${DateTime.formatIsoDateUtc(at)} ${timeText(at)}`
