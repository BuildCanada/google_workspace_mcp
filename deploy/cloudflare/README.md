# workspace-mcp on Cloudflare Containers

Runs the upstream Docker image as a single Cloudflare Container behind a thin
Worker, served at `https://workspace-mcp.svc.buildcanada.com`. This directory
is the only Build Canada specific part of the fork besides the `s3` OAuth
storage backend in `core/server.py`.

## How it fits together

- **Worker** (`src/index.ts`): routes every request to one named Durable
  Object that owns the container, and passes configuration in as environment
  variables. Nothing else runs in the Worker.
- **Container**: the repo's `Dockerfile`, started with
  `--transport streamable-http` in OAuth 2.1 multi-user mode with
  `WORKSPACE_MCP_STATELESS_MODE=true`. One `basic` instance (1 GiB, 1/4 vCPU),
  `max_instances: 1`, sleeps after 20 idle minutes.
- **State**: the FastMCP OAuth proxy keeps registered clients, the upstream
  Google tokens, refresh metadata, and in-flight transactions in a key-value
  store. Here that store is the R2 bucket `workspace-mcp-oauth-state`
  through the S3 API (`WORKSPACE_MCP_OAUTH_PROXY_STORAGE_BACKEND=s3`),
  encrypted at rest with a key derived from the Google client secret. The
  container can sleep or be redeployed without anyone re-consenting.
- **Auth**: the server's own OAuth 2.1 flow against Google. Each user consents
  once; MCP clients hold FastMCP-issued bearer tokens. Cloudflare Access sits
  in front of the human-facing paths only (see below).

## Deploy

```sh
cd deploy/cloudflare
npm install
npx wrangler deploy          # builds ../../Dockerfile with local Docker, pushes, deploys
```

Requires Docker running locally and the Workers Paid plan on the account.

The image build context is the repo root (`COPY . .` in the Dockerfile), so any
change in the repo produces a new image and `wrangler deploy` rolls the
container. A deploy with no source change keeps the running instance, and a
running instance keeps the environment it started with. After changing a
secret, restart it explicitly (team Access session required):

```sh
curl -X POST -H "cf-access-token: $(cloudflared access token -app=https://workspace-mcp.svc.buildcanada.com)" \
  https://workspace-mcp.svc.buildcanada.com/__admin/restart
```

The next request starts a fresh container with the current secrets. Nobody
re-consents: OAuth state is in R2, not in the container.

Secrets, set once with `npx wrangler secret put <NAME>`:

| Secret                       | Where it comes from                                              |
| ---------------------------- | ---------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`     | Google Cloud OAuth client (Web application) for the Workspace     |
| `GOOGLE_OAUTH_CLIENT_SECRET` | same client; also seeds the JWT signing and storage encryption keys, so rotating it invalidates every issued token |
| `R2_ACCESS_KEY_ID`           | R2 account API token "workspace-mcp oauth state" (1Password: `R2_WORKSPACE_MCP_OAUTH_STATE`) |
| `R2_SECRET_ACCESS_KEY`       | same token                                                        |

Non-secret settings live in `wrangler.jsonc` under `vars` (public URL, tool
tier, bucket, R2 endpoint).

## Google OAuth client

In the Build Canada Google Cloud project: APIs & Services → Credentials →
Create credentials → OAuth client ID → Web application.

- Authorised redirect URI: `https://workspace-mcp.svc.buildcanada.com/oauth2callback`
- Enable the APIs for the tools you use (Gmail, Calendar, Drive, Docs, Sheets,
  Slides, Tasks, Chat, Forms, People). The server requests scopes per tool
  tier; `core` is the default here.
- Set the consent screen to Internal so only Workspace accounts can consent.

## Cloudflare Access

Two self-hosted applications on the same hostname:

1. **workspace-mcp** on `workspace-mcp.svc.buildcanada.com` with the
   **Build Canada Team** policy. Covers `/authorize`, `/consent`,
   `/oauth2callback`, and anything else a browser reaches, so only team members
   can even start a Google consent.
2. **workspace-mcp machine endpoints** with a **Bypass** policy (Everyone) on
   the paths MCP clients and the OAuth 2.1 token exchange hit server to
   server: `/mcp`, `/mcp/*`, `/.well-known/*`, `/token`, `/register`,
   `/revoke`. Access evaluates the most specific destination first, so these
   paths skip the login and are protected by the server's bearer tokens
   instead.

## Connecting

Executor: add an MCP server with endpoint
`https://workspace-mcp.svc.buildcanada.com/mcp` and the `oauth2` auth method;
each user connects through the Executor UI, which runs the consent flow.

Claude Code or any OAuth-capable client:

```sh
claude mcp add --transport http workspace-mcp https://workspace-mcp.svc.buildcanada.com/mcp
```
