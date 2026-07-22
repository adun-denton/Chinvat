# Gmail module setup

The `gmail` module is the mail carrier for the chat-relay lane. It uses an
OAuth2 **installed-app** flow so a short-lived access token is minted per call
from a stored refresh token. Nothing but the calls to Gmail's own API leaves the
machine.

## 1. Create OAuth credentials

1. Google Cloud Console → new (or existing) project.
2. Enable the **Gmail API**.
3. OAuth consent screen → External (or Internal for Workspace) → add your own
   account as a test user.
4. Credentials → Create credentials → **OAuth client ID** → Desktop app.
5. Note the **client ID** and **client secret**.

Scope required: `https://www.googleapis.com/auth/gmail.modify` (send + read +
label). Use `gmail.readonly` + `gmail.send` if you prefer least privilege and do
not need the processed-label step.

## 2. Get a refresh token (one time, loopback)

Run the standard loopback consent once to obtain a refresh token — e.g. with
Google's `oauth2l`, the OAuth Playground (set your own client), or a short local
script that opens the consent URL and exchanges the code at
`https://oauth2.googleapis.com/token`. Request `access_type=offline` and
`prompt=consent` so a refresh token is returned.

Do **not** paste the refresh token anywhere but the module config.

## 3. Configure the module

Dashboard → Modules → gmail:

| Field | Value |
|---|---|
| `client_id` | OAuth client ID |
| `client_secret` | OAuth client secret |
| `refresh_token` | from step 2 |
| `poll_seconds` | inbox poll interval (default 30) |
| `relay_label` | label for processed relay mail (default `chinvat-processed`) |

`health()` authenticates and reports the account address when configured
correctly.

## 4. Use with chat-relay

- Set `chat-relay.return_to` to the address the chatbot should reply to (your
  own inbox).
- **ChatGPT lane:** prompt the session to send its reply by email to that
  address with subject `[CHINVAT <TASK_ID>]`. Find it with
  `gmail.poll_matching { query: "subject:[CHINVAT CR-...]" }`, then
  `gmail.read_message`, then `relay_import`.
- **Gemini lane:** prompt it to save the reply as a Gmail draft with the same
  subject. Find it with `gmail.list_drafts { subject_contains: "CHINVAT" }`,
  then `gmail.read_draft`, then `relay_import`.

## Security notes

- The refresh token is a long-lived credential; treat it like a password. It is
  stored in `data/chinvat.config.json` on your machine.
- `send_mail` and `label_processed` are `act` risk; at the default `approve`
  tier a send pauses for one approval click.
- Never route CLIENT-CONFIDENTIAL or higher content through the mail lane — keep
  it on the clipboard/file fallback. The packet compiler's classification
  ceiling enforces this at compile time.
