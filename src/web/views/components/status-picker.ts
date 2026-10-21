import { esc } from "../escape";

const checked = (on: boolean) => on ? " checked" : "";

/** Checkbox list of the tracker's statuses (deduplicated across teams) plus a free-text box for others. */
export function statusPicker(name: string, current: string[], statuses: { team: string; name: string; type: string }[], hint: string, tracker: string): string {
  const names = [...new Map(statuses.map((s) => [s.name.toLowerCase(), s])).values()];
  const known = new Set(names.map((s) => s.name.toLowerCase()));
  const other = current.filter((c) => !known.has(c.toLowerCase()));
  const boxes = names
    .map((s) => `<label class="opt"><input type="checkbox" name="${name}" value="${esc(s.name)}"${checked(current.some((c) => c.toLowerCase() === s.name.toLowerCase()))}>
      ${esc(s.name)} <span class="muted small">${esc(s.type)}</span></label>`)
    .join("");
  return `${boxes ? `<div class="opts">${boxes}</div>` : `<p class="muted small">Couldn't load your ${esc(tracker)} statuses; type them below.</p>`}
    <input type="text" name="${name}Other" value="${esc(other.join(", "))}" placeholder="Other statuses, comma-separated">
    <div class="muted small" style="margin-top:4px">${hint}</div>`;
}
