import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import "./styles.css";

const root = document.querySelector<HTMLDivElement>("#root");
if (root === null) throw new Error("Missing #root application element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
