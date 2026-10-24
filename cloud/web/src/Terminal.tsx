import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export function Terminal({ id, csrf }: { id: string; csrf: string }) {
  const element = useRef<HTMLDivElement>(null);
  const [state, setState] = useState("Connecting…"),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setState("Connecting…");
    let disposed = false;
    const term = new XTerm({
      fontSize: Number(localStorage.getItem("autopilot.terminalFont") || 13),
      fontFamily: '"SFMono-Regular", Consolas, monospace',
      cursorBlink: true,
      theme: { background: "#101115", foreground: "#e5e5ea" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element.current!);
    fit.fit();
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/v1/sessions/${id}/terminal?token=${encodeURIComponent(csrf)}`,
    );
    ws.binaryType = "arraybuffer";
    const resize = () => {
      if (disposed) return;
      fit.fit();
      if (ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ cols: term.cols, rows: term.rows }));
    };
    ws.onopen = () => {
      setState("Connected");
      resize();
      term.focus();
    };
    ws.onmessage = (e) => term.write(new Uint8Array(e.data));
    ws.onerror = () => setState("Could not attach. Retry the connection.");
    ws.onclose = () => {
      if (!disposed) setState("Disconnected");
    };
    const input = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(new TextEncoder().encode(data));
    });
    const observer = new ResizeObserver(resize);
    observer.observe(element.current!);
    return () => {
      disposed = true;
      ws.onclose = null;
      ws.close();
      observer.disconnect();
      input.dispose();
      term.dispose();
    };
  }, [id, csrf, attempt]);
  return (
    <section
      className="terminal-panel"
      data-connection={state}
      aria-label="Interactive terminal"
    >
      <span className="sr-only" role="status">
        {state}
      </span>
      {state !== "Connected" && (
        <div className="terminal-connection">
          {state}
          {state !== "Connecting…" && (
            <button onClick={() => setAttempt((n) => n + 1)}>Reconnect</button>
          )}
        </div>
      )}
      <div className="terminal" ref={element} />
    </section>
  );
}
