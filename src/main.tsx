/// <reference types="vite/client" />

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("React error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "20px", color: "red", fontFamily: "monospace" }}>
          <h2>Error</h2>
          <p>{this.state.error?.message}</p>
          <details>
            <pre>{this.state.error?.stack}</pre>
          </details>
        </div>
      );
    }

    return this.props.children;
  }
}

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error('Failed to find element with id "app". Check index.html.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
