# Feishu bot sends

Agent-initiated Feishu messages, sent by the hub through the same Feishu app
that provides web login. The bot never sends silently on behalf of someone
else: every message is attributed, and messages to other people or to groups
must be approved in HAPI first.

## Rules

| Target | Approval | Message shape |
|---|---|---|
| DM to the session owner (`to: "me"`) | Not required | The text as written |
| DM to anyone else | Required, one message at a time | The text as written |
| Group chat | Required, one message at a time | `<text>` followed by `—— 由 <at user_id="…"></at> 通过 HAPI 发送` |

Group sends are refused when the hub cannot resolve a human sender for the
session's namespace, or when that person is not a member of the group. The
member check is strict: if the Feishu member list is truncated or the bot
lacks the member-read scope, the send is refused rather than guessed.

Approvals appear in the session as a normal permission card on every HAPI
client. The card shows the recipient, sender, and exact text; it only offers
one-time "Approve and send" / "Deny" actions. After sending, the card shows
the `message_id` receipt and a receipt message is appended to the session.

## Hub configuration

The feature reuses the login app's bot identity:

| Variable | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | yes | Same app as Feishu login |
| `FEISHU_APP_SECRET` | yes | Stays on the hub |
| `FEISHU_OWNER_OPEN_ID` | recommended | Owner fallback for the `default` namespace |
| `FEISHU_SEND_APPROVAL_TTL_SECONDS` | no | Approval lifetime (default `600`) |
| `FEISHU_SEND_MAX_PER_MINUTE` | no | Per-namespace request rate limit (default `30`) |
| `FEISHU_DIRECTORY_SEARCH` | no | Set to `off` to skip the department-tree walk used for name addressing |

Feishu app requirements:

1. Enable the bot capability and publish an app version.
2. Add `im:message:send_as_bot` (send messages).
3. Add `im:chat:readonly` and `im:chat.members:read` (group search and the
   sender-in-group check).
4. Add `contact:user.base:readonly` and `contact:user.email:readonly` for
   display-name/email lookup. Directory name lookup additionally needs
   `contact:department.base:readonly`.
5. Make the app available to the people and groups that should be reachable.

Without the group/member scopes, group sends fail closed with a configuration
error. DM sends to an open_id or email continue to work with only
`im:message:send_as_bot`.

## Agent usage

The CLI exposes two MCP tools:

```jsonc
// DM to the owner, no approval
{ "kind": "dm", "to": "me", "text": "Nightly build finished." }

// DM to someone else, approval required
{ "kind": "dm", "to": "alice@example.com", "text": "Could you review PR 42?" }

// Group, approval required; the sender mention is added by the hub
{ "kind": "group", "chat": "Release coordination", "text": "v1.2.3 is live." }
```

`to` accepts an open_id (`ou_…`), an email, an exact display name, or `me`.
`chat` accepts a chat_id (`oc_…`) or a group name. Ambiguous names are
rejected with the candidate list instead of guessing. If the MCP call returns
`request_id=…`, the approval is still pending; `feishu_send_status` reports
the final state, and the hub sends automatically once approved.

Group text must not contain `<at>` tags. Mentions are appended by the hub so a
model cannot mention arbitrary users or `@all`.

## Failure modes

| Error | Meaning |
|---|---|
| `no_sender` | The session's namespace has no Feishu user and `default` has no owner fallback |
| `ambiguous_sender` | A namespace maps to multiple Feishu accounts; set `FEISHU_OWNER_OPEN_ID` |
| `recipient_not_found` / `recipient_ambiguous` | Name lookup failed; use an email or open_id |
| `sender_not_in_chat` | The sender is not a member of the target group |
| `sender_check_unavailable` | Member check failed or was truncated; the send is refused |
| `chat_not_found` / `chat_ambiguous` | Group lookup failed; use a chat_id |
| `rate_limited` | Too many requests, or five pending approvals already exist for the session |
| `expired` | Nobody approved before the TTL elapsed; nothing was sent |

## Notes

- The hub keeps the Feishu app secret; the CLI only calls hub routes with its
  namespace-scoped token.
- Group sends use the text message type and add the mention with
  `<at user_id="…"></at>`; Feishu renders the sender's display name.
- Approval state is in memory in the hub. A hub restart invalidates pending
  approvals; the CLI reports them as expired and never sends them late.
- Name addressing caches profiles from Feishu login and contact lookups. If
  the directory walk is disabled or incomplete, use an email or open_id.
