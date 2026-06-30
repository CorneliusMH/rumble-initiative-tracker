/// <reference types="vite/client" />

import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const rootElement = document.getElementById("app");
if (!rootElement) {
  throw new Error('Failed to find element with id "app". Check index.html.');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
