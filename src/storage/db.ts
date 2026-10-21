import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { issueExtras, type ExtraRepo, type IssueRow, type IssueStatus } from "../domain/issues";
export type { ExtraRepo, IssueRow, IssueStatus } from "../domain/issues";

export interface AssignmentRow {
  linear_id: string;
  identifier: string;
  assigned: number;
  handled: number;
  attempts: number;
  last_error: string | null;
  updated_at: string;
}

export const MAX_ATTEMPTS = 3;

const now = () => new Date().toISOString();

export class Store {
  readonly db: Database;

  constructor(stateDir: string) {
    mkdirSync(stateDir, { recursive: true });
    this.db = new Database(join(stateDir, "autopilot.sqlite"), { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS issues (
        linear_id      TEXT PRIMARY KEY,
        identifier     TEXT NOT NULL,
        title          TEXT NOT NULL,
        url            TEXT NOT NULL,
        brief_path     TEXT NOT NULL,
        repo           TEXT NOT NULL,
        repo_path      TEXT NOT NULL,
        branch         TEXT NOT NULL,
        confidence     REAL NOT NULL,
        resolve_reason TEXT NOT NULL,
        status         TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','running','failed')),
        error          TEXT,
        worktree_id    TEXT,
        ticket_json    TEXT NOT NULL,
        explainer_json TEXT NOT NULL,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS issues_identifier ON issues(identifier);
      -- Eligibility tracking (assigned to me + in a pickup state); "assigned" = currently eligible.
      CREATE TABLE IF NOT EXISTS assignments (
        linear_id  TEXT PRIMARY KEY,
        identifier TEXT NOT NULL,
        assigned   INTEGER NOT NULL,
        handled    INTEGER NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const columns = this.db.query<{ name: string }, []>("PRAGMA table_info(issues)").all().map((c) => c.name);
    if (!columns.includes("work_json")) this.db.exec("ALTER TABLE issues ADD COLUMN work_json TEXT");
    if (!columns.includes("launcher")) this.db.exec("ALTER TABLE issues ADD COLUMN launcher TEXT");
    if (!columns.includes("linear_state")) this.db.exec("ALTER TABLE issues ADD COLUMN linear_state TEXT; ALTER TABLE issues ADD COLUMN linear_state_type TEXT");
    if (!columns.includes("extra_repos_json")) this.db.exec("ALTER TABLE issues ADD COLUMN extra_repos_json TEXT NOT NULL DEFAULT '[]'");
    if (!columns.includes("triage_source")) {
      this.db.exec("ALTER TABLE issues ADD COLUMN triage_source TEXT");
      // Generated explainers always have a size; imported placeholders use an empty string.
      this.db.exec("UPDATE issues SET triage_source = 'automatic' WHERE json_extract(explainer_json, '$.size') IN ('S', 'M', 'L')");
    }
    // v2 tracks eligibility instead of plain assignment: re-baseline from scratch.
    if (this.getMeta("tracking_version") !== "2") {
      this.db.exec("DELETE FROM assignments; DELETE FROM meta WHERE key = 'poll_cursor';");
      this.setMeta("tracking_version", "2");
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string) {
    this.db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Setup banners the user dismissed; remembered across browsers and restarts. */
  dismissedBanners(): Set<string> {
    return new Set(JSON.parse(this.getMeta("dismissed_banners") ?? "[]") as string[]);
  }

  dismissBanner(id: string) {
    const ids = this.dismissedBanners();
    ids.add(id);
    this.setMeta("dismissed_banners", JSON.stringify([...ids]));
  }

  restoreBanners() {
    this.setMeta("dismissed_banners", "[]");
  }

  getAssignment(linearId: string): AssignmentRow | null {
    return this.db.query<AssignmentRow, [string]>("SELECT * FROM assignments WHERE linear_id = ?").get(linearId);
  }

  /** Records that the issue is (newly) assigned to me. `handled` = true skips the pipeline. */
  markAssigned(linearId: string, identifier: string, handled: boolean) {
    this.db
      .query(
        `INSERT INTO assignments (linear_id, identifier, assigned, handled, attempts, last_error, updated_at)
         VALUES (?, ?, 1, ?, 0, NULL, ?)
         ON CONFLICT(linear_id) DO UPDATE SET identifier = excluded.identifier, assigned = 1,
           handled = excluded.handled, attempts = 0, last_error = NULL, updated_at = excluded.updated_at`,
      )
      .run(linearId, identifier, handled ? 1 : 0, now());
  }

  markUnassigned(linearId: string) {
    this.db.query("UPDATE assignments SET assigned = 0, updated_at = ? WHERE linear_id = ?").run(now(), linearId);
  }

  markHandled(linearId: string) {
    this.db.query("UPDATE assignments SET handled = 1, updated_at = ? WHERE linear_id = ?").run(now(), linearId);
  }

  recordAttemptFailure(linearId: string, error: string) {
    this.db
      .query("UPDATE assignments SET attempts = attempts + 1, last_error = ?, updated_at = ? WHERE linear_id = ?")
      .run(error, now(), linearId);
  }

  assignedIds(): string[] {
    return this.db.query<{ linear_id: string }, []>("SELECT linear_id FROM assignments WHERE assigned = 1").all().map((r) => r.linear_id);
  }

  unhandled(): AssignmentRow[] {
    return this.db
      .query<AssignmentRow, [number]>("SELECT * FROM assignments WHERE assigned = 1 AND handled = 0 AND attempts < ? ORDER BY updated_at")
      .all(MAX_ATTEMPTS);
  }

  static extras(row: IssueRow): ExtraRepo[] {
    return issueExtras(row);
  }

  getIssue(linearId: string): IssueRow | null {
    return this.db.query<IssueRow, [string]>("SELECT * FROM issues WHERE linear_id = ?").get(linearId);
  }

  getIssueByIdentifier(identifier: string): IssueRow | null {
    return this.db.query<IssueRow, [string]>("SELECT * FROM issues WHERE identifier = ?").get(identifier);
  }

  upsertIssue(row: Omit<IssueRow, "created_at" | "updated_at" | "work_json" | "launcher" | "linear_state" | "linear_state_type" | "triage_source"> & { triage_source?: IssueRow["triage_source"] }) {
    const t = now();
    this.db
      .query(
        `INSERT OR REPLACE INTO issues (linear_id, identifier, title, url, brief_path, repo, repo_path, branch,
           confidence, resolve_reason, status, error, worktree_id, ticket_json, explainer_json, extra_repos_json, triage_source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.linear_id, row.identifier, row.title, row.url, row.brief_path, row.repo, row.repo_path,
        row.branch, row.confidence, row.resolve_reason, row.status, row.error, row.worktree_id, row.ticket_json,
        row.explainer_json, row.extra_repos_json, row.triage_source === undefined ? "automatic" : row.triage_source, t, t,
      );
  }

  updateIssue(
    linearId: string,
    fields: Partial<
      Pick<IssueRow, "repo" | "repo_path" | "branch" | "status" | "error" | "worktree_id" | "extra_repos_json" | "launcher" | "linear_state" | "linear_state_type" |
        "title" | "url" | "ticket_json" | "explainer_json" | "confidence" | "resolve_reason" | "triage_source">
    >,
  ) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return;
    const sets = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => fields[k] ?? null);
    this.db.query(`UPDATE issues SET ${sets}, updated_at = ? WHERE linear_id = ?`).run(...values, now(), linearId);
  }

  /** Stores the latest work check; only a material change bumps updated_at (which reloads the page). */
  setWork(linearId: string, workJson: string, bump: boolean) {
    if (bump) this.db.query("UPDATE issues SET work_json = ?, updated_at = ? WHERE linear_id = ?").run(workJson, now(), linearId);
    else this.db.query("UPDATE issues SET work_json = ? WHERE linear_id = ?").run(workJson, linearId);
  }

  /** Atomically moves an issue between statuses; returns false if it was not in one of `from`. */
  transition(linearId: string, from: IssueStatus[], to: IssueStatus): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const res = this.db
      .query(`UPDATE issues SET status = ?, error = NULL, updated_at = ? WHERE linear_id = ? AND status IN (${placeholders})`)
      .run(to, now(), linearId, ...from);
    return res.changes === 1;
  }

  listByStatus(statuses: IssueStatus[], limit = 100): IssueRow[] {
    const placeholders = statuses.map(() => "?").join(", ");
    return this.db
      .query<IssueRow, (string | number)[]>(`SELECT * FROM issues WHERE status IN (${placeholders}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...statuses, limit);
  }
}
