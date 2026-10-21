export const offlinePage = (port: number, logPath: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10;url=/">
<title>Autopilot · offline</title>
<style>
  :root { --bg:#f4f4f1; --panel:#fff; --text:#1b1b19; --muted:#6d6d67; --border:#e4e4de; --code:#efefea; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f0e; --panel:#191917; --text:#ededea; --muted:#9b9b94; --border:#2a2a27; --code:#262624; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--text);
    font:14px/1.55 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; padding:16px; box-sizing:border-box; }
  .box { max-width:520px; background:var(--panel); border:1px solid var(--border); border-radius:16px; padding:28px; }
  img { width:44px; height:44px; }
  h1 { font-size:18px; margin:14px 0 6px; }
  p { color:var(--muted); margin:8px 0; }
  code { display:block; background:var(--code); border-radius:8px; padding:10px 12px; font:12.5px ui-monospace, Menlo, monospace;
    color:var(--text); white-space:pre-wrap; word-break:break-all; margin-top:6px; }
</style>
</head>
<body>
  <div class="box">
    <img src="/icons/icon.svg" alt="">
    <h1>autopilot isn't running</h1>
    <p>The local daemon behind this app isn't answering on port ${port}. Restart it with:</p>
    <code>autopilot service restart</code>
    <p>Logs: <code>${logPath}</code></p>
    ${port !== 4747 ? `<p><strong>Installed from a different port?</strong> An installed app is tied to the address it was installed from. If autopilot now runs on its default port, <a href="http://localhost:4747/">open http://localhost:4747</a> and install the app from there.</p>` : ""}
    <p>This page retries every 10 seconds.</p>
  </div>
</body>
</html>
`;
