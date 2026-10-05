---
description: DM yourself on Slack with Linear tickets matching a filter
argument-hint: <filter, e.g. "assigned to me, In Review">
---

Send me a Slack DM listing Linear tickets that match this filter: $ARGUMENTS

If the filter is empty, use "assigned to me, not Done or Canceled".

Steps:
1. Use the Linear MCP tools to find issues matching the filter. "me" means the authenticated Linear user.
2. Sort by priority (Urgent first), then by last updated.
3. Build one message. Plain Slack mrkdwn, no em dashes:
   - First line: `*Linear: <filter>* (<count> tickets)`
   - One line per ticket: `• <url|IDENTIFIER> title · status · priority`
   - Cap at 30 tickets. If more matched, end with `…and N more`.
   - If none matched, send `*Linear: <filter>*: no tickets.`
4. Use the Slack MCP tools to find my Slack user by email `ben.papp@runpod.io`, then send the message as a DM to myself. Do not post anywhere else.
5. Reply with one line: how many tickets were sent, or the error.
