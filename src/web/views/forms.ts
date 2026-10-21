import { esc } from "./escape";

export const csrfField = (token: string) => `<input type="hidden" name="csrf" value="${esc(token)}">`;
