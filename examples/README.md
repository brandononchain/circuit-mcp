# Starter boards

Each file here is a workflow in Circuit's export format — the same JSON that
sits inside a saved workflow page. To use one, paste its contents into a
conversation with the Circuit connector on and say **import this workflow**, or
hand it to `circuit_import` directly.

Every one of them names connector tools you may not have. Circuit will tell you
which, and suggest the nearest thing in your own tool list, before it lets you
run anything.

| File | What it does | Connectors it assumes |
| --- | --- | --- |
| `inbox-triage.json` | Reads unread mail, sorts it, drafts the sales replies, holds each one for you | Gmail, Google Calendar |
| `weekly-digest.json` | Every Friday, gathers the week in one turn and posts a summary | Gmail, Google Calendar, Slack |
| `lead-intake.json` | Turns a form submission into a CRM record and a first reply | a forms tool, Airtable, Gmail |

They are meant to be edited. Rewire them on the board, swap the connectors for
the ones you actually have, and save your version.
