// Keeps a ground-view failure (WebGL, data, bug) inside the ground view: the rest of the app stays
// up and the user can go back to orbit, instead of React unmounting the whole page.

import { Component, type ReactNode } from "react";

export class GroundViewBoundary extends Component<{ onExit: () => void; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Ground view failed:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="ground-view ground-error" role="alert">
        <p>The ground view could not start: {this.state.error.message}</p>
        <button type="button" onClick={this.props.onExit}>
          Back to orbit
        </button>
      </div>
    );
  }
}
