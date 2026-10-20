// Files imported with `with { type: "file" }` resolve to a path (inside the binary when compiled).
declare module "*.png" {
  const path: string;
  export default path;
}
declare module "*.svg" {
  const path: string;
  export default path;
}
