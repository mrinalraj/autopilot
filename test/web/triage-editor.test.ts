import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../../src/web/assets/live.js", import.meta.url), "utf8");
type Reply = Pick<Response, "redirected" | "headers" | "ok" | "json">;

/** Exercise the real submit handler without a network connection or a user's browser. */
function editor(reply: () => Promise<Reply>, action = "edit-triage") {
  const fields = new Map([ ["summary", "Keep this draft"], ["approach", "Two\nlines"], ["expected", "original"], ["csrf", "fixture"],
    ["repo", "api"], ["branch", "fix-widget-eng-1"], ["extra", "web"] ]);
  const error = { hidden: true, textContent: "", scrollIntoView: () => {} };
  const classes = new Set<string>(), attributes = new Map<string, string>();
  const label = action === "edit-triage" ? "Update" : "Approve & launch";
  const button = { dataset: {} as Record<string, string>, innerHTML: label, textContent: label,
    classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
    hasAttribute: (name: string) => name === "data-skip-triage" && action === "reject",
    getAttribute: (name: string) => name === "formaction" && action !== "edit-triage" ? `/issues/ENG-1/${action}` : null,
    setAttribute: (name: string, value: string) => attributes.set(name, value), removeAttribute: (name: string) => attributes.delete(name) };
  const form = { dataset: {} as Record<string, string>, action: "http://localhost/issues/ENG-1/edit-triage",
    elements: { namedItem: (name: string) => ({ set value(value: string) { fields.set(name, value); } }) },
    hasAttribute: (name: string) => name === "data-triage-edit", querySelector: () => error };
  let submit!: (event: unknown) => void;
  let request: FormData | null = null, requests = 0, reloads = 0, location = "", url = "";
  runInNewContext(script, {
    document: { addEventListener: (name: string, callback: typeof submit) => { if (name === "submit") submit = callback; }, getElementById: () => null },
    addEventListener: () => {},
    FormData: class extends FormData { constructor() { super(); for (const [key, value] of fields) this.set(key, value); } },
    fetch: async (target: string, init: { body: FormData }) => { url = target; request = init.body; requests++; return reply(); },
    history: { replaceState: (_state: unknown, _title: string, url: string) => { location = url; } },
    location: { reload: () => { reloads++; } },
  });
  const send = () => {
    let prevented = false;
    submit({ target: form, submitter: button, preventDefault: () => { prevented = true; } });
    expect(prevented).toBe(action !== "reject");
  };
  const settled = async () => {
    const deadline = Date.now() + 1000;
    while (form.dataset.busy && !reloads) {
      if (Date.now() > deadline) throw new Error("save handler did not finish");
      await Bun.sleep(1);
    }
  };
  return { fields, form, button, error, classes, attributes, send, settled, state: () => ({ request, requests, reloads, location, url }) };
}

test("failed triage saves retain the draft and restore the save button", async () => {
  for (const reply of [
    async () => Response.json({ ok: false, error: "The triage changed since you opened this form." }, { status: 400 }),
    async () => { throw new Error("Connection lost"); },
    async () => ({ redirected: true } as Reply),
  ]) {
    const f = editor(reply), draft = [...f.fields];
    f.send();
    await f.settled();
    expect([...f.fields]).toEqual(draft);
    expect(f.error.hidden).toBe(false);
    expect(f.error.textContent.length).toBeGreaterThan(0);
    expect(f.form.dataset.busy).toBeUndefined();
    expect(f.classes.has("busy")).toBe(false);
    expect(f.attributes.has("aria-busy")).toBe(false);
    expect(f.button.innerHTML).toBe("Update");
    expect(f.state().reloads).toBe(0);
  }
});

test("successful saves submit the full draft once and reload the returned ticket", async () => {
  let finish!: (value: Reply) => void;
  const gate = new Promise<Reply>((resolve) => { finish = resolve; });
  const f = editor(() => gate);
  f.send();
  f.send();
  expect(f.state().requests).toBe(1);
  expect(f.state().request?.get("response")).toBe("json");
  expect(f.state().request?.get("summary")).toBe("Keep this draft");
  expect(f.state().request?.get("expected")).toBe("original");
  const location = "/?notice=Saved#m-ENG-1";
  finish(Response.json({ ok: true, location }));
  await f.settled();
  expect(f.state().location).toBe(location);
  expect(f.state().reloads).toBe(1);
});

test("approval submits unsaved text with routing to the approve endpoint and keeps failed drafts", async () => {
  const f = editor(async () => Response.json({ ok: false, error: "Summary is required." }, { status: 400 }), "approve");
  f.send();
  await f.settled();
  expect(f.state().url).toBe("/issues/ENG-1/approve");
  expect(f.state().request?.get("summary")).toBe("Keep this draft");
  expect(f.state().request?.get("repo")).toBe("api");
  expect(f.state().request?.getAll("extra")).toEqual(["web"]);
  expect(f.error.textContent).toBe("Summary is required.");
  expect(f.fields.get("summary")).toBe("Keep this draft");
  expect(f.button.innerHTML).toBe("Approve & launch");
  expect(f.state().requests).toBe(1);
  expect(f.state().reloads).toBe(0);

  const saved = editor(async () => Response.json({ ok: true, location: "/?logs=1" }), "approve");
  saved.send();
  await saved.settled();
  expect(saved.state().location).toBe("/?logs=1");
  expect(saved.state().reloads).toBe(1);
});

test("a launch failure after saving keeps the saved revision for a retry; rejection skips saving", async () => {
  const f = editor(async () => Response.json({ ok: false, error: "Brief unavailable", expected: "saved revision" }, { status: 400 }), "approve");
  f.send();
  await f.settled();
  expect(f.fields.get("expected")).toBe("saved revision");
  expect(f.fields.get("summary")).toBe("Keep this draft");
  const reject = editor(async () => { throw new Error("Reject should submit natively"); }, "reject");
  reject.send();
  expect(reject.state().requests).toBe(0);
});
