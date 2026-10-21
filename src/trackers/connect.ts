import { oauthRedirectUrl, type Config } from "../config/config";
import { JiraClient } from "./jira";
import { LinearClient } from "./linear";
import { oauthAccount } from "../platform/keychain";
import { KeychainOAuthProvider, McpSession } from "./mcp";
import { LoginRequiredError, trackerSpec, type Tracker } from "./tracker";

/**
 * The configured tracker's client and OAuth provider. Without `onAuthorize` (the daemon, reset)
 * a missing or revoked login throws LoginRequiredError instead of opening a browser.
 */
export function openTracker(cfg: Config, onAuthorize?: (url: URL) => void | Promise<void>) {
  const spec = trackerSpec(cfg);
  const provider = new KeychainOAuthProvider(oauthAccount(spec.keychainAccount), oauthRedirectUrl(cfg), spec.scope(cfg), onAuthorize ?? (() => {
    throw new LoginRequiredError(spec.label);
  }));
  const session = new McpSession(spec.mcpUrl, provider, spec.label);
  const tracker: Tracker = spec.kind === "jira" ? new JiraClient(session, cfg.jira.site) : new LinearClient(session);
  return { spec, provider, tracker };
}
