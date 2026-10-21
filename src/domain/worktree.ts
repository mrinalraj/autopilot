/** Worktree IDs retain Supacode's percent-encoded path format for every launcher. */
export const supacodeId = (path: string) => encodeURIComponent(path.endsWith("/") ? path : path + "/");
export const pathFromId = (id: string) => decodeURIComponent(id).replace(/\/$/, "");
