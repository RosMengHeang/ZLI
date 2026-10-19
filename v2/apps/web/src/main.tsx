import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@zli-v2/ui/tokens.css";
import { AppShell } from "./shell/AppShell.js";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element for the ZLI renderer.");

createRoot(rootElement).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
