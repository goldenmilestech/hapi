# Feishu login

Optional. When enabled, people sign in to the web UI with their Feishu account, and the hub gives each person a namespace automatically. Manual token issuance is only needed for service accounts after that.

## Hub configuration

| Variable | Required | Description |
|---|---|---|
| `FEISHU_APP_ID` | yes | App ID from the Feishu developer console |
| `FEISHU_APP_SECRET` | yes | App secret; stays on the hub |
| `FEISHU_REDIRECT_URI` | no | Defaults to `{publicUrl}/auth/feishu`. Must match the Feishu app's redirect URL exactly |
| `FEISHU_SCOPE` | no | Defaults to `contact:user.email:readonly`. Add scopes only if you need email binding |
| `FEISHU_OWNER_OPEN_ID` | no | Feishu `open_id` that maps to the `default` (owner) namespace |
| `FEISHU_OWNER_EMAIL` | no | Email fallback for the owner |

`HAPI_PUBLIC_URL` must be the URL people actually use; the default redirect derives from it. A localhost redirect is rejected for remote clients.

## Feishu app setup

1. Create a custom app in the Feishu developer console.
2. Enable the web app capability and add `https://<your-hub>/auth/feishu` to the redirect URLs.
3. Request the user email permission (`contact:user.email:readonly`) if you want email-based binding.
4. Publish a version and grant the app to the people who should be able to sign in.

## Namespace mapping

On each login the hub resolves the user in this order:

1. `FEISHU_OWNER_OPEN_ID` / `FEISHU_OWNER_EMAIL` → `default`
2. an existing Feishu user row (`open_id`) → its namespace
3. an owner-created email binding → that namespace
4. otherwise a new opaque namespace `fs_<hash(open_id)>`

A namespace can be mapped to only one Feishu account. If a binding collides, the login is rejected and the owner must fix the binding.

Email binding trusts the email returned by the Feishu directory. Use `FEISHU_OWNER_OPEN_ID` for the owner identity; Feishu recommends treating email and mobile as directory data rather than a verified login credential.

## CLI / runner token

Feishu login authenticates the browser, not the runner. After signing in:

1. Open **Settings → Access tokens → My access token**.
2. Copy the token and use it as `CLI_API_TOKEN`.

The token is derived from a hub-local secret, so the page can show it again at any time. "Regenerate" invalidates the previous token immediately; every device using it must sign in again. The web session and the CLI share the same personal token, because a namespace has exactly one active token.

## Binding an existing namespace

If someone already has sessions under a manual namespace, the owner can keep them:

1. Open **Settings → Access tokens → Feishu bindings**.
2. Add the person's Feishu email with their existing namespace.
3. Their next Feishu login maps to that namespace instead of a new one.

The binding only applies before the first login for that `open_id`. Once a user has a namespace, the user row wins.

If the bound namespace already has an old manually created token that predates derived tokens, the first Feishu login rotates it so the user gets a viewable token. The old CLI credential stops working at that point.

## Turning off the shared token

Once every person signs in through Feishu, set `HAPI_LEGACY_SHARED_TOKEN=off` and restart. Bound namespaces already reject the legacy token; this flag removes the remaining unbound ones. Keep at least one `default`-namespace personal token before disabling it, otherwise the owner cannot sign in.
