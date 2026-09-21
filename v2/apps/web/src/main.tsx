import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@zli-v2/ui/tokens.css";
import { AppShell } from "./shell/AppShell.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
