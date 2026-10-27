import { Console, Effect } from "effect"

/**
 * What a run says, in its log and its summary, with every secret's text replaced by `***`: the
 * repository is public, and so are its runs' logs. GitHub masks each secret as a whole; the parts
 * of one (a device token in a list, the host of the deployment's URL) are masked here.
 */
export interface Report {
  /** A line of the run's log and summary. */
  readonly line: (text: string) => Effect.Effect<void>
  /** A failure GitHub shows on the run, red, and in its log and summary. */
  readonly failure: (text: string) => Effect.Effect<void>
  /** A warning GitHub shows on the run, and in its log and summary. */
  readonly warning: (text: string) => Effect.Effect<void>
  /** `text` with every secret replaced by `***`. */
  readonly redact: (text: string) => string
  /** Whether a failure was reported, which fails the run. */
  readonly failed: () => boolean
  /** The summary so far, as Markdown, for the run's page. */
  readonly summary: () => string
}

// Shorter values would hide ordinary words; no secret here is this short.
const shortestSecret = 6

/**
 * The parts of `secrets` to mask: each whole, each of its lines, and a URL's host, longest first,
 * so a longer secret is replaced before a shorter one inside it.
 */
export const secretParts = (secrets: ReadonlyArray<string>): ReadonlyArray<string> => {
  const parts = new Set<string>()
  for (const secret of secrets) {
    for (const part of [secret, ...secret.split(/\r?\n/).map((line) => line.trim())]) {
      if (part.length >= shortestSecret) {
        parts.add(part)
      }
    }
    const host = /^https?:\/\/([^/:?#]+)/i.exec(secret)?.[1]
    if (host !== undefined && host.length >= shortestSecret) {
      parts.add(host)
    }
  }
  return [...parts].sort((a, b) => b.length - a.length)
}

/** `text` with each of `parts` replaced by `***`. */
export const redactWith = (parts: ReadonlyArray<string>, text: string) =>
  parts.reduce((redacted, part) => redacted.split(part).join("***"), text)

// GitHub's workflow commands end at a line's end, so a message's own line breaks are escaped.
const commandText = (text: string) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")

/**
 * A report for a run, masking `secrets`. In GitHub Actions (`actions`), it first tells the runner
 * to mask every part of them in the rest of the log, and says failures and warnings as workflow
 * commands, which GitHub shows on the run.
 */
export const makeReport = Effect.fn("makeReport")(function* (secrets: ReadonlyArray<string>, actions: boolean) {
  const parts = secretParts(secrets)
  if (actions) {
    for (const part of parts) {
      yield* Console.log(`::add-mask::${commandText(part)}`)
    }
  }
  const lines: Array<string> = []
  let failed = false
  const redact = (text: string) => redactWith(parts, text)
  const say = (prefix: string, summaryPrefix: string, text: string) => {
    const safe = redact(text)
    lines.push(`${summaryPrefix}${safe}`)
    return Console.log(actions && prefix !== "" ? `${prefix}${commandText(safe)}` : safe)
  }
  const report: Report = {
    line: (text) => say("", "", text),
    failure: (text) =>
      Effect.suspend(() => {
        failed = true
        return say("::error::", "**Failed:** ", text)
      }),
    warning: (text) => say("::warning::", "**Warning:** ", text),
    redact,
    failed: () => failed,
    summary: () => lines.map((line) => `${line}\n`).join("\n"),
  }
  return report
})
