import { expect, test } from "bun:test";
import { isValidBranch, normalizeBranch } from "../../src/triage/branch";

test("valid branches pass through", () => {
  expect(normalizeBranch("fix-login-redirect-eng-4821", "ENG-4821", "x")).toBe("fix-login-redirect-eng-4821");
});

test("repairs case, separators and missing suffix", () => {
  expect(normalizeBranch("Fix Login_Redirect", "ENG-4821", "x")).toBe("fix-login-redirect-eng-4821");
});

test("moves a misplaced identifier to the end", () => {
  expect(normalizeBranch("eng-4821-fix-login-redirect", "ENG-4821", "x")).toBe("fix-login-redirect-eng-4821");
  expect(normalizeBranch("ENG4821/fix tab", "ENG-4821", "x")).toBe("fix-tab-eng-4821");
});

test("caps at five words and tops up from the title", () => {
  expect(normalizeBranch("one two three four five six", "ENG-1", "t")).toBe("one-two-three-four-five-eng-1");
  expect(normalizeBranch("fix", "ENG-1", "The login redirect loop")).toBe("fix-login-redirect-loop-eng-1");
  expect(normalizeBranch("", "ENG-1", "")).toBe("ticket-work-eng-1");
});

test("validation rejects bad shapes", () => {
  expect(isValidBranch("fix-eng-1", "ENG-1")).toBe(false);
  expect(isValidBranch("a-b-c-d-e-f-eng-1", "ENG-1")).toBe(false);
  expect(isValidBranch("fix-tab-eng-12", "ENG-1")).toBe(false);
  expect(isValidBranch("fix-tab-eng-1; rm -rf /", "ENG-1")).toBe(false);
  for (const raw of ["a; rm -rf ~", "$(touch x)", "`id`", "--upload-pack=evil"]) {
    expect(isValidBranch(normalizeBranch(raw, "ENG-1", "t"), "ENG-1")).toBe(true);
  }
});
