export type Meta = {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type Workspace = Meta & {
  githubAccountId: string;
  gitlabAccountId: string;
  name: string;
  root: string;
  workerHarness: string;
  orchestratorHarness: string;
};
export type Repository = Meta & {
  workspaceId: string;
  name: string;
  path: string;
  remote: string;
  defaultBranch: string;
  provider: string;
  integrationId: string;
  providerRepo: string;
  setup: string[];
};
export type Project = Meta & {
  workspaceId: string;
  name: string;
  description: string;
};
export type Issue = Meta & {
  workflowState: string;
  workflowDetail: string;
  planIds: string[];
  planningSessionId: string;
  workspaceId: string;
  projectId: string;
  parentId: string;
  identifier: string;
  title: string;
  description: string;
  acceptance: string;
  status: string;
  priority: number;
  labels: string[];
  source: string;
  integrationId: string;
  externalId: string;
  externalUrl: string;
  externalStatus: string;
  sourceUpdatedAt: string;
};
export type Task = {
  id: string;
  issueId: string;
  title: string;
  prompt: string;
  repositoryIds: string[];
  dependsOn: string[];
  harness: string;
};
export type Plan = Meta & {
  workspaceId: string;
  issueId: string;
  title: string;
  summary: string;
  tasks: Task[];
  state: string;
};
export type Run = Meta & {
  workspaceId: string;
  executionId: string;
  task: Task;
  state: string;
  error: string;
  worktrees: {
    id?: string;
    repositoryId: string;
    path: string;
    branch: string;
    setupDone: boolean;
  }[];
  sessionId: string;
  repairs: number;
  completedAt: string;
};
export type Profile = {
  id: string;
  label: string;
  command: string;
  args: string[];
  promptMode: string;
  resumeArgs: string[];
};
export type Worktree = Meta & {
  workspaceId: string;
  repositoryId: string;
  name: string;
  path: string;
  branch: string;
  base: string;
  head: string;
  primary: boolean;
  origin: string;
  status: string;
  pinned: boolean;
  hidden: boolean;
  issueIds: string[];
};
export type Session = Meta & {
  kind: string;
  worktreeId: string;
  worktreeIds: string[];
  workspaceId: string;
  runId: string;
  role: string;
  harness: Profile;
  handle: string;
  directory: string;
  generation: string;
  conversationId: string;
  state: string;
  signalSource: string;
  error: string;
  prompt: string;
};
export type Integration = Meta & {
  webhookEnabled: boolean;
  lastWebhook: string;
  pollInterval: number;
  watchStatuses: string[];
  intakeEnabled: boolean;
  authMethod: string;
  cliAccount: string;
  verifiedAccount: string;
  lastVerified: string;
  workspaceId: string;
  provider: string;
  label: string;
  baseUrl: string;
  username: string;
  scope: string;
  statusMap: Record<string, string>;
  lastSync: string;
  error: string;
  enabled: boolean;
};
export type Action = Meta & {
  kind: string;
  entityId: string;
  state: string;
  body: string;
  error: string;
};
export type Change = Meta & {
  runId: string;
  repositoryId: string;
  number: number;
  url: string;
  title: string;
  state: string;
  checks: string;
  error: string;
};
export type Plugin = {
  id: string;
  type: string;
  label: string;
  available: boolean;
  reason: string;
  capabilities: string[];
  distributions: string[];
};
export type Event = {
  sequence: number;
  at: string;
  entityId: string;
  kind: string;
  message: string;
};
export type Snapshot = {
  executions: { id: string; planId: string; workspaceId: string }[];
  queue: (Meta & {
    workspaceId: string;
    issueId: string;
    integrationId: string;
    state: string;
  })[];
  worktrees: Worktree[];
  csrf: string;
  workspaces: Workspace[];
  repositories: Repository[];
  projects: Project[];
  issues: Issue[];
  comments: (Meta & {
    issueId: string;
    body: string;
    source: string;
    author: string;
  })[];
  plans: Plan[];
  runs: Run[];
  sessions: Session[];
  integrations: Integration[];
  actions: Action[];
  changes: Change[];
};
export const columns = [
  { id: "backlog", label: "Backlog", color: "var(--lane-triage, #8a8d99)" },
  { id: "ready", label: "Ready", color: "var(--lane-working, #b6bbcf)" },
  { id: "in_progress", label: "In progress", color: "var(--lane-review, #e5b85d)" },
  { id: "in_review", label: "In review", color: "var(--lane-attention, #a99bea)" },
  { id: "done", label: "Done", color: "var(--lane-done, #77ba94)" },
  { id: "canceled", label: "Canceled", color: "var(--lane-triage, #85858a)" },
];
export const priorities = ["No priority", "Urgent", "High", "Medium", "Low"];
export const isLive = (s: Session) =>
  ["starting", "working", "idle", "unknown", "needs_input"].includes(s.state);
