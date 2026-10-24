import { Component, type ReactNode } from "react";

// An open window can still reference a lazy chunk from the previous server build.
export class AppBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="loading" role="alert">
        <h1>This view could not be loaded</h1>
        <p>The app may have been updated, or the server connection was lost. Reconnect and reload the interface.</p>
        <p>Running agents stay on the server. Unsaved form edits will be lost when you reload.</p>
        <button onClick={() => window.location.reload()}>Reload interface</button>
      </main>
    );
  }
}
