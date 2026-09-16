import { Container, getContainer } from "@cloudflare/containers";

// Vars come from the generated worker-configuration.d.ts (`wrangler types`);
// secrets are declared here because wrangler cannot see them.
declare global {
  interface Env {
    GOOGLE_OAUTH_CLIENT_ID: string;
    GOOGLE_OAUTH_CLIENT_SECRET: string;
    R2_ACCESS_KEY_ID: string;
    R2_SECRET_ACCESS_KEY: string;
  }
}

// One Durable Object owns the single container instance. Every request is
// routed to the same named object so the process sees a consistent view of
// its in-memory caches; the durable OAuth state is in R2, not in the container.
export class WorkspaceMcp extends Container<Env> {
  defaultPort = 8000;
  // Cold starts take several seconds (Python + 120 tools). Sleep only after a
  // quiet stretch so an active agent session never pays that mid-conversation.
  sleepAfter = "20m";

  // Class field so it is evaluated after DurableObject sets this.env.
  override envVars: Record<string, string> = (() => {
    const env = this.env;
    return {
      PORT: "8000",
      WORKSPACE_MCP_HOST: "0.0.0.0",
      TOOL_TIER: env.TOOL_TIER,
      // OAuth 2.1 multi-user auth with the server's own OAuth proxy in front of Google.
      MCP_ENABLE_OAUTH21: "true",
      WORKSPACE_MCP_STATELESS_MODE: "true",
      GOOGLE_OAUTH_CLIENT_ID: env.GOOGLE_OAUTH_CLIENT_ID,
      GOOGLE_OAUTH_CLIENT_SECRET: env.GOOGLE_OAUTH_CLIENT_SECRET,
      // The public origin the OAuth endpoints and Google redirect must advertise.
      WORKSPACE_EXTERNAL_URL: env.PUBLIC_URL,
      GOOGLE_OAUTH_REDIRECT_URI: `${env.PUBLIC_URL}/oauth2callback`,
      // OAuth proxy state (DCR clients, upstream Google tokens, refresh
      // metadata) in R2 through the S3 API — survives sleep and redeploys.
      WORKSPACE_MCP_OAUTH_PROXY_STORAGE_BACKEND: "s3",
      WORKSPACE_MCP_OAUTH_PROXY_S3_BUCKET: env.R2_BUCKET,
      WORKSPACE_MCP_OAUTH_PROXY_S3_ENDPOINT_URL: env.R2_ENDPOINT_URL,
      WORKSPACE_MCP_OAUTH_PROXY_S3_REGION: "auto",
      WORKSPACE_MCP_OAUTH_PROXY_S3_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      WORKSPACE_MCP_OAUTH_PROXY_S3_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      // Longer client-facing token life reduces refresh races for agents.
      WORKSPACE_MCP_OAUTH_PROXY_ACCESS_TOKEN_EXPIRY_SECONDS: "86400",
      WORKSPACE_MCP_OAUTH_PROXY_TOKEN_EXPIRY_THRESHOLD_SECONDS: "60",
    };
  })();
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const container = getContainer(env.WORKSPACE_MCP, "default");
    const url = new URL(request.url);
    // Operational hook: a running container keeps the environment it started
    // with, so new Worker secrets (a rotated Google client secret, new R2
    // keys) only take effect after a restart. This path sits behind the team
    // Cloudflare Access app, not the machine-endpoint bypass, so only a
    // signed-in team member can reach it. The next request starts a fresh
    // container with the current secrets.
    if (url.pathname === "/__admin/restart" && request.method === "POST") {
      await container.destroy();
      return new Response("container stopped; next request starts it with current secrets\n");
    }
    return container.fetch(request);
  },
} satisfies ExportedHandler<Env>;
