import { esc } from "../escape";
import { badge, modalId, time, ago, stageBadge, prState, repoPills, workSummary } from "./ticket-shared";
import { issueExtras, explainerOf, ticketOf, workOf, worktreesOf, type IssueRow } from "../../../domain/issues";
import { atRisk, overallStage, stage, type RepoWork } from "../../../domain/work";
import { pathFromId } from "../../../domain/worktree";
import type { TicketViewData } from "../../models";

export function ticketComponents(data: TicketViewData) {
  const { tokenField } = data;
  const actionBase = (r: IssueRow) => `/issues/${encodeURIComponent(r.identifier)}`;
  const isLow = (r: IssueRow) => r.confidence < data.cfg.lowConfidenceThreshold;
  const actionable = (r: IssueRow) => r.status === "pending" || r.status === "failed";

  function confidence(r: IssueRow) {
    return `<span class="conf${isLow(r) ? " low" : ""}" title="Repo confidence">${isLow(r) ? "low " : ""}${Math.round(r.confidence * 100)}%
      <span class="meter"><i style="width:${Math.round(r.confidence * 100)}%"></i></span></span>`;
  }

  function card(r: IssueRow) {
    const ex = explainerOf(r);
    const id = modalId(r.identifier);
    // Low-confidence items are approved from the modal, where the repo can be changed.
    const approve = isLow(r)
      ? `<a class="btn primary" href="#${id}">Review</a>`
      : `<form method="post" action="${actionBase(r)}/approve">${tokenField}
           <input type="hidden" name="repo" value="${esc(r.repo)}"><input type="hidden" name="branch" value="${esc(r.branch)}">
           ${issueExtras(r).map((e) => `<input type="hidden" name="extra" value="${esc(e.repo)}">`).join("")}
           <button class="primary" data-busy-label="Launching…">${r.status === "failed" ? "Retry launch" : "Approve"}</button></form>`;
    const actions = actionable(r)
      ? `<div class="actions">${approve}<form method="post" action="${actionBase(r)}/reject">${tokenField}<button class="ghost-danger" data-busy-label="Rejecting…">Reject</button></form></div>`
      : "";
    return `<article class="card s-${r.status}">
      <div class="cardhead">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>${confidence(r)}</div>
      <a class="title" href="#${id}">${esc(r.title)}</a>
      <div class="pills">${repoPills(r)}${ex.size ? `<span class="pill">size ${esc(ex.size)}</span>` : ""}<span class="pill mono">${esc(r.branch)}</span></div>
      <div class="summary">${esc(ex.summary)}</div>
      ${r.status === "failed" && r.error ? `<div class="alert">${esc(r.error)}</div>` : ""}
      ${r.status === "approved" || data.steps.has(r.identifier) ? stepLine(r) : noteLine(r)}
      ${actions}
    </article>`;
  }

  /** Opens existing work with the selected launcher, regardless of its original tool. */
  const linkFor = (r: IssueRow, path: string) => data.worktreeLinks.get(r.linear_id)?.get(path) ?? null;
  const worktreeLink = (r: IssueRow) => (r.worktree_id ? linkFor(r, pathFromId(r.worktree_id)) : null);

  /** Live step of a launch or background action on this ticket. */
  const stepLine = (r: IssueRow) =>
    `<div class="step"><span class="spinner"></span><span data-step="${esc(r.identifier)}">${esc(data.steps.get(r.identifier) ?? "Starting…")}</span></div>`;
  /** Result of the ticket's last background action (e.g. a refused delete). */
  const noteLine = (r: IssueRow) => {
    const n = data.notes.get(r.identifier);
    return n?.level === "error" ? `<div class="alert">${esc(n.msg)}</div>` : "";
  };

  function workCard(r: IssueRow) {
    const list = workOf(r);
    const st = list ? overallStage(list) : "working";
    const wt = worktreeLink(r);
    const multi = (list?.length ?? 0) > 1;
    const prs = (list ?? []).filter((w) => w.pr);
    const linearState = r.linear_state ? `<span class="pill linear" title="Linear status">${esc(r.linear_state)}</span>` : "";
    const summary = r.worktree_id ? workSummary(list) : `<div class="workline">No worktree found for this ticket; showing its ${esc(data.trackerLabel)} status only.</div>`;
    return `<article class="card w-${st}">
      <div class="cardhead">${r.worktree_id ? stageBadge(st) : ""}<span class="ident">${esc(r.identifier)}</span>${linearState}</div>
      <a class="title" href="#${modalId(r.identifier)}">${esc(r.title)}</a>
      <div class="pills">${r.repo ? repoPills(r) : ""}<span class="pill mono">${esc(r.branch)}</span></div>
      ${summary}
      ${data.steps.has(r.identifier) ? stepLine(r) : noteLine(r)}
      <div class="actions">${prs.map((w) => `<a class="btn primary" href="${esc(w.pr!.url)}" target="_blank" rel="noreferrer">${multi ? `${esc(w.repo)} ` : ""}PR #${w.pr!.number} ↗</a>`).join("")}
        ${wt ? `<a class="btn" href="${esc(wt)}">Open worktree</a>` : ""}${promptButton(r)}</div>
    </article>`;
  }

  function recentItem(r: IssueRow) {
    const list = r.status === "running" ? workOf(r) : null;
    if (list) {
      const prs = list.filter((w) => w.pr).map((w) => `PR #${w.pr!.number}`).join(", ");
      return `<a class="item" href="#${modalId(r.identifier)}">${stageBadge(overallStage(list))}<span class="ident">${esc(r.identifier)}</span>
        <span class="t">${esc(r.title)}</span><span class="muted small">${prs ? `${esc(prs)} · ` : ""}${esc([r.repo, ...issueExtras(r).map((e) => e.repo)].join(" + "))} · ${esc(time(r.updated_at))}</span></a>`;
    }
    return `<a class="item" href="#${modalId(r.identifier)}">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>
      <span class="t">${esc(r.title)}</span>
      <span class="muted small">${r.status === "rejected" && r.error ? `${esc(r.error.replace(/^Dismissed: /, ""))} · ` : ""}${esc(r.repo)} · ${esc(time(r.updated_at))}</span></a>`;
  }

  function progressBox(r: IssueRow) {
    const list = workOf(r);
    if (!list?.length) return `<div class="box"><h3>Progress</h3><p class="muted" style="margin:0">Not checked yet.</p></div>`;
    const repoFacts = (w: RepoWork) => {
      const wt = linkFor(r, w.worktreePath);
      return `<dl class="facts">
        <dt>Repo</dt><dd><strong>${esc(w.repo)}</strong> ${stageBadge(stage(w))}</dd>
        <dt>Pull request</dt><dd>${w.pr ? `<a href="${esc(w.pr.url)}" target="_blank" rel="noreferrer">#${w.pr.number} ${esc(w.pr.title)}</a> · ${esc(prState(w.pr))}` : "none yet"}</dd>
        <dt>Commits</dt><dd>${w.commitsAhead ?? "?"} ahead of base${w.lastCommitAt ? ` · last ${esc(ago(w.lastCommitAt))}` : ""}</dd>
        <dt>Uncommitted</dt><dd>${w.dirtyFiles ?? "?"} file${w.dirtyFiles === 1 ? "" : "s"}</dd>
        <dt>Worktree</dt><dd>${w.missing ? "removed" : wt ? `<a href="${esc(wt)}">Open</a>` : ""} <code>${esc(w.worktreePath)}</code></dd>
      </dl>${w.error ? `<div class="alert" style="margin-top:8px">${esc(w.error)}</div>` : ""}`;
    };
    return `<div class="box"><h3>Progress · checked ${esc(ago(list[0].checkedAt))}</h3>
      <div class="cardhead" style="margin-bottom:10px">${stageBadge(overallStage(list))}</div>
      ${list.map(repoFacts).join("")}</div>`;
  }

  function promptButton(r: IssueRow) {
    if (!data.canResendPrompt || !r.worktree_id || r.status !== "running") return "";
    const disabled = data.steps.has(r.identifier) ? " disabled" : "";
    return `<form method="post" action="${actionBase(r)}/resend-prompt">${tokenField}<button data-busy-label="Sending…"${disabled}>Send prompt to chat</button></form>`;
  }

  /** "Send back to approval…": undo a launch (removes what's left of its worktrees), keeping triage. */
  function sendBackBox(r: IssueRow) {
    if ((r.status !== "running" && r.status !== "failed") || !r.repo) return "";
    if (data.steps.has(r.identifier)) return `<div class="box">${stepLine(r)}</div>`;
    const risks = (workOf(r) ?? []).flatMap((w) => atRisk(w).map((x) => `${w.repo}: ${x}`));
    return `<details class="danger"><summary>Send back to approval…</summary>
      <p class="small muted" style="margin:8px 0 4px">Moves this ticket back to Awaiting approval with its current repo, branch and explainer, so you can approve it again. Any of its worktrees that still exist are removed first using the selected launcher; its branches are kept and reused.</p>
      ${risks.length ? `<div class="alert">At the last check this would lose: ${esc(risks.join(", "))}. It's re-checked first.</div>` : ""}
      <form method="post" action="${actionBase(r)}/send-back">${tokenField}
        <label class="check"><input type="checkbox" name="force" value="1"> Remove worktrees anyway, even with uncommitted or unpushed work</label>
        <button class="ghost-danger" type="submit" data-busy-label="Sending back…">Send back to approval</button></form>
    </details>`;
  }

  /** "Delete worktrees…" for launched tickets, listing what would be lost from the latest check. */
  function deleteBox(r: IssueRow) {
    if (r.status !== "running" && r.status !== "failed") return "";
    if (data.steps.has(r.identifier)) return "";
    const wts = worktreesOf(r);
    const work = workOf(r) ?? [];
    const live = wts.filter((w) => !work.find((x) => x.repo === w.repo)?.missing);
    if (!live.length) return "";
    const risks = work.flatMap((w) => atRisk(w).map((x) => `${w.repo}: ${x}`));
    return `<details class="danger"><summary>Delete worktree${live.length === 1 ? "" : "s"}…</summary>
      <p class="small muted" style="margin:8px 0 4px">Removes ${live.length === 1 ? "this worktree" : "these worktrees"} using the selected launcher. The branch, commits already pushed, and any PR stay; PR tracking carries on.</p>
      <ul class="small">${live.map((w) => `<li><code>${esc(decodeURIComponent(w.worktreeId).replace(/\/$/, ""))}</code></li>`).join("")}</ul>
      ${risks.length ? `<div class="alert">At the last check this would lose: ${esc(risks.join(", "))}. It's re-checked before deleting.</div>` : ""}
      <form method="post" action="${actionBase(r)}/delete-worktrees">${tokenField}
        <label class="check"><input type="checkbox" name="force" value="1"> Delete anyway, even with uncommitted or unpushed work</label>
        <button class="ghost-danger" type="submit" data-busy-label="Deleting…">Delete worktree${live.length === 1 ? "" : "s"}</button></form>
    </details>`;
  }

  function modal(r: IssueRow) {
    const ex = explainerOf(r);
    const t = ticketOf(r);
    const low = isLow(r);
    const options = data.catalog
      .map((c) => `<option value="${esc(c.name)}"${c.name === r.repo ? " selected" : ""}>${esc(c.name)} — ${esc(c.path)}</option>`)
      .join("");

    const form = actionable(r)
      ? `<form method="post" action="${actionBase(r)}/approve">${tokenField}
          <div class="${low ? "lowconf" : ""}">
            ${low ? `<p class="warnnote"><strong>Low confidence (${Math.round(r.confidence * 100)}%).</strong> Check the repo before approving.</p>` : ""}
            <label for="repo-${esc(r.identifier)}" style="margin-top:${low ? "8px" : "0"}">Repo</label><select id="repo-${esc(r.identifier)}" name="repo">${options}</select>
            <div class="muted small" style="margin-top:6px">${esc(r.resolve_reason)}</div>
          </div>
          <div class="grouplabel" id="also-${esc(r.identifier)}">Also change</div>
          <div class="checks" role="group" aria-labelledby="also-${esc(r.identifier)}">${data.catalog
            .filter((c) => c.name !== r.repo)
            .map((c) => {
              const e = issueExtras(r).find((x) => x.repo === c.name);
              return `<label><input type="checkbox" name="extra" value="${esc(c.name)}"${e ? " checked" : ""}>
                <span>${esc(c.name)}${e?.reason ? ` <span class="muted small">— ${esc(e.reason)}</span>` : ""}</span></label>`;
            })
            .join("")}</div>
          <div class="muted small" style="margin-top:6px">Each repo gets its own worktree on the same branch; the session starts in the primary repo with the others added.</div>
          <label for="branch-${esc(r.identifier)}">Branch</label>
          <input type="text" id="branch-${esc(r.identifier)}" name="branch" value="${esc(r.branch)}" autocomplete="off" spellcheck="false">
          <div class="muted small" style="margin-top:6px">2–5 word kebab slug ending in <code>-${esc(r.identifier.toLowerCase())}</code>. Invalid names are repaired automatically.</div>
          <div class="actionsbar"><button class="primary" type="submit" data-busy-label="Launching…">${r.status === "failed" ? "Retry launch" : "Approve &amp; launch"}</button>
            <button class="ghost-danger" type="submit" formaction="${actionBase(r)}/reject" data-busy-label="Rejecting…">Reject</button></div>
        </form>`
      : `<p style="margin:0"><strong>Repo:</strong> ${esc(r.repo)} <span class="muted">(${esc(r.repo_path)})</span>
          ${issueExtras(r).map((e) => `<br><strong>Also:</strong> ${esc(e.repo)} <span class="muted">(${esc(e.repo_path)})</span>`).join("")}
          <br><strong>Branch:</strong> <code>${esc(r.branch)}</code>
          ${r.worktree_id ? `<br><strong>Worktree:</strong> <code>${esc(decodeURIComponent(r.worktree_id))}</code>` : ""}</p>
         ${r.error ? `<div class="alert" style="margin-top:10px">${esc(r.error)}</div>` : ""}`;

    const comments = t.comments.length
      ? t.comments.map((c) => `<div class="muted small" style="margin-bottom:4px"><strong>${esc(c.author)}</strong> · ${esc(new Date(c.createdAt).toLocaleString())}</div><pre>${esc(c.body)}</pre>`).join("")
      : `<p class="muted" style="margin:0">No comments.</p>`;

    return `<div class="modal" id="${modalId(r.identifier)}" role="dialog" aria-modal="true" aria-label="${esc(r.identifier)}">
      <a class="backdrop" href="#" aria-label="Close"></a>
      <div class="panel">
        <div class="head"><div class="grow">
            <div class="cardhead">${badge(r.status, r.error)}<span class="ident">${esc(r.identifier)}</span>
              <span class="muted small">${esc(t.state)} · ${esc(t.team)}${t.project ? ` · ${esc(t.project)}` : ""}${t.labels.length ? ` · ${esc(t.labels.join(", "))}` : ""}</span></div>
            <h1>${esc(r.title)}</h1>
            <div class="small" style="margin-top:4px"><a href="${esc(r.url)}" rel="noreferrer" target="_blank">Open in ${esc(data.trackerLabel)} ↗</a></div>
          </div><a class="close" href="#" aria-label="Close">×</a></div>
        <div class="body">
          ${r.status === "failed" && r.error ? `<div class="alert" style="margin-bottom:14px"><strong>Launch failed.</strong> ${esc(r.error)}</div>` : ""}
          <div class="cols">
            <div><div class="box"><h3>Ticket description · verbatim, untrusted</h3><pre>${esc(t.description ?? "(empty)")}</pre></div>
              <div class="box"><h3>Comments · verbatim</h3>${comments}</div></div>
            <div>
              <div class="box"><h3>${ex.approach ? `Explainer${ex.size ? ` · size ${esc(ex.size)}` : ""}` : "Summary"}</h3><p style="margin-top:0">${esc(ex.summary)}</p>
                <p><strong>Approach.</strong> ${esc(ex.approach)}</p>
                <strong class="small">Likely areas</strong><ul class="small">${ex.likely_areas.map((a) => `<li><code>${esc(a)}</code></li>`).join("")}</ul>
                </div>
              ${r.status === "running" ? progressBox(r) : ""}
              ${deleteBox(r)}
              ${sendBackBox(r)}
              <div class="box"><h3>Launch</h3>${form}
                ${data.steps.has(r.identifier) ? stepLine(r) : noteLine(r)}
                ${data.canResendPrompt ? `<div class="actions">${promptButton(r)}</div>` : ""}
                <p class="small muted" style="margin:14px 0 0">Brief for the session: <code>${esc(r.brief_path)}</code></p></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  }


  return { card, workCard, recentItem, modal };
}
