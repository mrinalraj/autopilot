// Files imported with `with { type: "file" }` resolve to a path (inside the binary when compiled).
declare module "*.png" {
  const path: string;
  export default path;
}

// Browser assets are bundled as text into the standalone executable.
declare module "*.css" {
  const text: string;
  export default text;
}
declare module "*.js" {
  const text: string;
  export default text;
}
declare module "*.svg" {
  const path: string;
  export default path;
}
