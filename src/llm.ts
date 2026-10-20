import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";

export interface JsonRequest {
  system: string;
  prompt: string;
  /** JSON Schema for the response; every object needs additionalProperties: false. */
  schema: Record<string, unknown>;
}

export interface LLM {
  json<T>(req: JsonRequest): Promise<T>;
}

/**
 * `claude -p` headless, using the local Claude Code login. Runs with no tools, no MCP
 * servers and no user settings: the prompt carries untrusted ticket text, so the model
 * must not be able to act on it.
 */
class ClaudeCliLLM implements LLM {
  private readonly cwd: string;

  constructor(private readonly cfg: Config) {
    this.cwd = join(cfg.stateDir, "llm-cwd");
    mkdirSync(this.cwd, { recursive: true });
  }

  async json<T>(req: JsonRequest): Promise<T> {
    const proc = Bun.spawn(
      [
        this.cfg.llm.claudeBin, "-p",
        "--output-format", "json",
        "--model", this.cfg.llm.model,
        "--tools", "",
        "--strict-mcp-config",
        "--setting-sources", "",
        "--no-session-persistence",
        "--system-prompt", req.system,
        "--json-schema", JSON.stringify(req.schema),
      ],
      { cwd: this.cwd, stdin: new Blob([req.prompt]), stdout: "pipe", stderr: "pipe" },
    );
    const timer = setTimeout(() => proc.kill(), 300_000);
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`claude -p exited ${code}: ${stderr.trim().slice(0, 500) || stdout.slice(0, 500)}`);
    const out = JSON.parse(stdout) as { is_error?: boolean; result?: string; structured_output?: T };
    if (out.is_error || out.structured_output === undefined) {
      throw new Error(`claude -p returned no structured output: ${String(out.result ?? "").slice(0, 300)}`);
    }
    return out.structured_output;
  }
}

/** Anthropic Messages API with structured outputs. Needs ANTHROPIC_API_KEY. */
class AnthropicApiLLM implements LLM {
  constructor(private readonly cfg: Config) {}

  async json<T>(req: JsonRequest): Promise<T> {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();
    // Server-side fallback re-runs a classifier-declined request on another model.
    const params = {
      model: this.cfg.llm.model,
      max_tokens: 16000,
      system: req.system,
      messages: [{ role: "user" as const, content: req.prompt }],
      output_config: { effort: "medium", format: { type: "json_schema", schema: req.schema } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    };
    const response = await client.beta.messages.create(params as unknown as Parameters<typeof client.beta.messages.create>[0]);
    if (!("content" in response)) throw new Error("unexpected streaming response");
    if (response.stop_reason === "refusal") throw new Error("model declined the request (refusal)");
    if (response.stop_reason === "max_tokens") throw new Error("response hit max_tokens");
    const text = response.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("");
    return JSON.parse(text) as T;
  }
}

export function createLLM(cfg: Config): LLM {
  if (cfg.llm.provider === "api") {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("llm.provider is 'api' but ANTHROPIC_API_KEY is not set");
    return new AnthropicApiLLM(cfg);
  }
  return new ClaudeCliLLM(cfg);
}
