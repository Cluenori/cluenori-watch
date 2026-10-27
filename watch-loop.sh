#!/usr/bin/env bash
# One watching run: a check at once, then one on every 5-minute mark of the clock, for LOOP_MINUTES
# (340, 5 h 40 min, under GitHub's 6-hour limit for a job). Each check is a whole `node src/main.ts`,
# which reads the outage's state from its issue and writes it back there, so checks share nothing
# else, within a run or across runs. A failed check doesn't stop the next; the run fails at the end
# if any did. The workflow's next job then starts the next run.
set -u

minutes=${LOOP_MINUTES:-340}
case $minutes in
  '' | *[!0-9]*)
    echo "::error::LOOP_MINUTES must be a whole number of minutes, not \"$minutes\""
    exit 2
    ;;
esac
if [ "$minutes" -gt 340 ]; then
  minutes=340
fi
every=${EVERY_SECONDS:-300}
until=$(($(date +%s) + minutes * 60))
failed=0

while :; do
  # A check takes 2 minutes at most; one that hangs is stopped, so the run still hands over.
  timeout 270 node src/main.ts || failed=1
  now=$(date +%s)
  next=$((now - now % every + every))
  if [ "$next" -ge "$until" ]; then
    break
  fi
  sleep $((next - now))
done
exit $failed
