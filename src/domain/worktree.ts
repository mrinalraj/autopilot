/** Provider-independent identity. Preserve the existing encoded-path format for stored tickets. */
export const worktreeId = (path: string) => encodeURIComponent(path.endsWith("/") ? path : path + "/");
export const pathFromId = (id: string) => decodeURIComponent(id).replace(/\/$/, "");
