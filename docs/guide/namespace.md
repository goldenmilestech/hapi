# Namespace (Advanced)

Namespaces are intended for small teams sharing a single public HAPI hub. Each team member uses a different namespace to isolate their sessions and machines without running separate hubs.

This is not a default setup path for most users.

HAPI supports three credential models. All bind a credential to a namespace; they differ in who chooses it.

## Feishu login (recommended for teams)

See [Feishu login](./feishu-login.md). Each person signs in with their Feishu account; the hub allocates `fs_<hash(open_id)>` on first login, or an existing namespace when the owner pre-binds their email. The CLI token is available from **Settings → Access tokens → My access token**, so nobody has to distribute tokens by hand.

## Per-person access tokens (manual)

The hub owner issues a token per person. The hub stores the token's namespace, so a client cannot switch namespaces by editing the credential.

1. Sign in to the web as the owner (the `default` namespace).
2. Open **Settings → Access tokens** and create one token per person, each with its own namespace.
3. Give the token to that person. They use it as `CLI_API_TOKEN` for the CLI/runner and paste the same value when signing in from the web or a native app.
4. Revoke a token from the same screen when someone leaves or a device is lost.

Each namespace holds **one active token**. Use the same token on all of a person's devices; revoke it before issuing a replacement. An expired token does not block a new one.

Binding a namespace also **closes it to the legacy shared token**: once `alice` has a token, `base:alice` stops authenticating, and legacy JWTs previously exchanged for that namespace are rejected. This is what prevents someone who holds — or guesses — the shared token from entering another person's namespace.

Revocation is immediate: new requests are rejected, and live CLI/terminal sockets and SSE streams authenticated by that token are disconnected. The hub persists only a SHA-256 digest; the plaintext is shown once at creation.

Tokens can also be managed over the owner-only HTTP API:

```
GET  /api/access-tokens
POST /api/access-tokens            {"name": "...", "namespace": "..."}
POST /api/access-tokens/:id/revoke
```

## Legacy shared token

The original model uses a single hub secret with a client-chosen suffix:

- The hub uses a single base `CLI_API_TOKEN`.
- Clients append `:<namespace>` to the token for isolation.

It stays enabled by default for backward compatibility. A namespace that has an active access token is already off-limits to the legacy token; the flag only controls the remaining unbound namespaces. Once every client uses a hub-issued token, set `HAPI_LEGACY_SHARED_TOKEN=off` and restart the hub; `base:anything` then stops authenticating everywhere.

Create an owner token bound to the `default` namespace **before** disabling the legacy path, otherwise nobody can sign in to the owner-only screens to create one. The hub logs a warning at startup when the legacy path is off and no active `default` token exists.

## Setup (legacy shared token)

1. On the hub, configure only the base token:

```
CLI_API_TOKEN="your-base-token"
```

2. For each user, append a namespace in the client token:

```
CLI_API_TOKEN="your-base-token:alice"
```

3. Web login and Telegram binding should use the same `base:namespace` token.

## Limitations and gotchas

- **The legacy shared token is isolation, not authorization.** Anyone who holds the base token can choose any *unbound* namespace, including `default`. Binding a namespace to an access token closes it to the legacy token; disable the legacy path entirely before sharing a hub with people you do not trust.
- Hub-side `CLI_API_TOKEN` must not include `:<namespace>`. The hub validates the token from both the environment variable and `settings.json`, and refuses to start with an error if a suffix is present.
- Namespaces are isolated: sessions, machines, and users are not visible across namespaces. `default` is the owner namespace and is the only one allowed to read usage/storage or change hub-level settings.
- One machine ID cannot be reused across namespaces.
  - To run multiple namespaces on one machine, use a separate `HAPI_HOME` per namespace, or clear the machine ID with `hapi auth logout` before switching.
- Remote spawn is namespace-scoped. If you need remote spawning for multiple namespaces on the same machine, run a separate runner per namespace (use separate `HAPI_HOME`).
