/**
 * Render marketing fixtures from the real app templates and stylesheet.
 * All data below is fictional. Never load config.json, the DB, Keychain, or a tracker.
 * Run: bun scripts/generate-site-previews.ts
 * Serve .dev/site-fixtures and capture dashboard.html / settings.html in a browser.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../src/config/config';
import type { DashboardData } from '../src/web/models';
import { dashboardBody } from '../src/web/views/dashboard';
import { settingsBody } from '../src/web/views/settings';
import styles from '../src/web/assets/styles.css' with { type: 'text' };
import { issue, work } from '../test/fixtures/issues';

const output = resolve('.dev/site-fixtures');
mkdirSync(output, { recursive: true });
const now = Date.parse('2026-10-01T10:40:00Z');
const originalNow = Date.now;
Date.now = () => now;
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
const cfg: Config = {
  tracker: 'linear', jira: { site: '' }, pollIntervalSeconds: 1200,
  workCheckIntervalSeconds: 300, port: 4747, oauthCallbackPort: 4748,
  repoRoots: ['/Users/demo/code'], repoPaths: [], onboarded: true,
  ticketPrefixes: ['APP'], stateDir: '/Users/demo/.autopilot/state',
  briefsDir: '/Users/demo/.autopilot/briefs', githubUser: 'alex-demo', linearUserId: '',
  pickupStates: ['Ready for Development'], importStates: ['In Development'],
  importWorktrees: true, processExistingOnFirstRun: true, moveToInProgressOnApprove: false,
  lowConfidenceThreshold: 0.6,
  llm: { provider: 'cli', model: 'claude-opus-5-5', claudeBin: 'claude' },
  launch: { launcher: 'superset', terminal: 'terminal', ideSession: 'chat', cursorChat: 'claude',
    worktreesDir: '/Users/demo/worktrees', supacodeBin: 'supacode', supersetBin: 'superset',
    claudeBin: 'claude', fetch: true, base: 'main', background: false },
  repos: {},
};
const catalog = ['orbit-web', 'orbit-api', 'orbit-docs'].map(name => ({
  name, path: `/Users/demo/code/${name}`, description: 'Fictional demo repository', topLevel: ['src'],
}));
const queue = [
  { number: 128, title: 'Add keyboard shortcuts', summary: 'Navigate the command menu with the keyboard. Keep focus visible and predictable.', repo: 'orbit-web', confidence: .96 },
  { number: 142, title: 'Export reports as CSV', summary: 'Let people export the current report, with the same filters and column order.', repo: 'orbit-api', confidence: .91 },
].map((item, index) => issue({
  linear_id: `demo-${item.number}`, identifier: `APP-${item.number}`, title: item.title,
  url: `https://example.test/issues/APP-${item.number}`, brief_path: `/Users/demo/.autopilot/briefs/APP-${item.number}.md`,
  repo: item.repo, repo_path: `/Users/demo/code/${item.repo}`, branch: `${index ? 'export-report-csv' : 'add-keyboard-shortcuts'}-app-${item.number}`,
  confidence: item.confidence, resolve_reason: index ? 'The export endpoint belongs to orbit-api. The report action lives in orbit-web.' : 'The command menu and keyboard navigation live in orbit-web.',
  status: 'pending', launcher: 'superset', created_at: ago(35), updated_at: ago(18 + index * 6),
  linear_state: 'Ready for Development',
  ticket_json: JSON.stringify({
    description: index ? '## Goal\nExport the current report as a CSV file.\n\n## Expected behavior\n- Keep the selected filters and column order.\n- Use clear column headings.\n- Show progress while the file is prepared.\n- Offer a useful empty state when there are no results.\n\n## Acceptance criteria\nThe exported rows match the visible report. Keyboard and screen-reader users can start the export.' : '## Goal\nMake the command menu work from the keyboard.\n\n## Acceptance criteria\nArrow keys move between results, Enter selects a result, and Escape closes the menu. Focus returns to the trigger.',
    comments: [{ author: 'Sam Taylor', createdAt: ago(30), body: 'Please keep the existing report filters when exporting.' }],
    team: 'Product Engineering', project: index ? 'Reporting' : 'Navigation', labels: [], attachments: [], state: 'Ready for Development',
  }),
  explainer_json: JSON.stringify({ summary: item.summary,
    approach: index ? 'Add a CSV endpoint and connect it to the report toolbar. Reuse the existing filter serializer.' : 'Add keyboard handlers and focus management to the command menu.',
    likely_areas: index ? ['src/reports/export.ts', 'src/components/ReportToolbar.tsx'] : ['src/components/CommandMenu.tsx'], size: index ? 'M' : 'S' }),
  extra_repos_json: index ? JSON.stringify([{repo:'orbit-web',repo_path:'/Users/demo/code/orbit-web',reason:'Add the export action and download state to the report toolbar.',worktree_id:null}]) : '[]',
}));
const active = [
  [136, 'Improve search filters', 'Search', 3], [139, 'Add a loading state', 'Navigation', 2],
  [145, 'Save notification preferences', 'Settings', 5], [151, 'Add a weekly summary', 'Reporting', 4],
] as const;
const inProgress = active.map(([number, title, project, dirtyFiles]) => issue({
  linear_id:`demo-${number}`, identifier:`APP-${number}`, title, url:`https://example.test/issues/APP-${number}`,
  repo:'orbit-web', repo_path:'/Users/demo/code/orbit-web', branch:`improve-workflow-app-${number}`,
  brief_path:`/Users/demo/.autopilot/briefs/APP-${number}.md`, status:'running', launcher:'superset',
  worktree_id:`/Users/demo/worktrees/app-${number}`, linear_state:'In Development', linear_state_type:'started',
  created_at:ago(180), updated_at:ago(20),
  ticket_json:JSON.stringify({description:'Improve the everyday workflow.',comments:[],team:'Product Engineering',project,labels:[],attachments:[],state:'In Development'}),
  explainer_json:JSON.stringify({summary:'Make the next action clear and easy to complete.',approach:'Update the interface and add focused checks.',likely_areas:['src/components'],size:'S'}),
  work_json:JSON.stringify([work({repo:'orbit-web',worktreePath:`/Users/demo/worktrees/app-${number}`,checkedAt:ago(3),commitsAhead:0,dirtyFiles})]),
}));
const completed = [[102,'Remember the last workspace'],[117,'Update the onboarding checklist']].map(([number,title],index)=>issue({
  linear_id:`demo-${number}`, identifier:`APP-${number}`, title:String(title), url:`https://example.test/issues/APP-${number}`,
  repo:'orbit-web',repo_path:'/Users/demo/code/orbit-web',branch:`finish-workflow-app-${number}`,
  brief_path:`/Users/demo/.autopilot/briefs/APP-${number}.md`,status:'running',launcher:'superset',
  worktree_id:`/Users/demo/worktrees/app-${number}`,linear_state:'Done',linear_state_type:'completed',
  created_at:ago(300),updated_at:ago(60+index*40),
  ticket_json:JSON.stringify({description:'Complete this fictional demo task.',comments:[],team:'Product Engineering',project:'Navigation',labels:[],attachments:[],state:'Done'}),
  explainer_json:JSON.stringify({summary:'Keep the experience consistent.',approach:'Update the shared interface.',likely_areas:['src/components'],size:'S'}),
  work_json:JSON.stringify([work({repo:'orbit-web',worktreePath:`/Users/demo/worktrees/app-${number}`,checkedAt:ago(3),commitsAhead:3,pr:{number:42+index,url:`https://example.test/pr/${42+index}`,title:String(title),state:'MERGED',isDraft:false}})]),
}));
const data: DashboardData = {
  cfg,queue,launching:[],inProgress,inReview:[],completed,prsOpen:0,rejected:[],catalog,
  trackerLabel:'Linear',steps:new Map(),notes:new Map(),tokenField:'',canResendPrompt:false,
  worktreeLinks:new Map(inProgress.map(r=>[r.linear_id,new Map([[r.worktree_id!,'#']])])),
  dismissed:new Set(),logs:[],lastPollAt:ago(1),lastPollError:null,polling:false,signingIn:false,
  empty:false,version:'demo',bootId:'demo',progress:{current:null,done:0,total:0},activity:null,
};
// Force only the app's existing dark theme. No layout or component restyling.
const darkStyles = styles.replace('@media (prefers-color-scheme: dark)', '@media all');
const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Autopilot — fictional demo fixture</title><link rel="icon" href="data:,"><style>${darkStyles}</style></head><body><main>${body}</main></body></html>`;
writeFileSync(`${output}/dashboard.html`,page(dashboardBody(data).replace('<details class="fold">','<details class="fold" open>')));
const launched = {
  ...queue[1], status: 'running' as const, linear_state: 'In Development', linear_state_type: 'started',
  worktree_id: '/Users/demo/worktrees/app-142',
  work_json: JSON.stringify([work({repo:'orbit-api',worktreePath:'/Users/demo/worktrees/app-142',checkedAt:ago(1),commitsAhead:0,dirtyFiles:3})]),
};
const merged = {
  ...launched, linear_state: 'Done', linear_state_type: 'completed', updated_at:ago(1),
  work_json: JSON.stringify([work({repo:'orbit-api',worktreePath:'/Users/demo/worktrees/app-142',checkedAt:ago(1),commitsAhead:4,pr:{number:48,url:'https://example.test/pr/48',title:'Export reports as CSV',state:'MERGED',isDraft:false}})]),
};
for (const [name, state] of [
  ['launched', {...data, queue:[queue[0]], inProgress:[launched,...inProgress.slice(0,3)]}],
  ['merged', {...data, queue:[queue[0]], inProgress:inProgress.slice(0,3), completed:[merged,completed[0]]}],
] as const) writeFileSync(`${output}/${name}.html`,page(dashboardBody(state).replace('<details class="fold">','<details class="fold" open>')));
let settings = settingsBody({cfg,version:'0.1.0-beta.9',paths:{config:'/Users/demo/.autopilot/config.json',home:'/Users/demo/.autopilot',log:'/Users/demo/.autopilot/autopilot.log'},tracker:'Linear',signingIn:false,tokenField:'',dismissedTips:0});
settings = settings.replace('Checking your account…','Signed in as Alex Morgan · alex@example.test')
  .replace('Sign in to Linear</button>','Switch account</button>')
  .replace('Checking GitHub accounts…','Available accounts from gh')
  .replace('data-settings-link="connections"','data-settings-link="connections" aria-current="page"')
  .replace('data-when-tracker="jira"','data-when-tracker="jira" hidden');
writeFileSync(`${output}/settings.html`,page(settings));
Date.now = originalNow;
console.log(`Rendered fictional app fixtures to ${output}`);
