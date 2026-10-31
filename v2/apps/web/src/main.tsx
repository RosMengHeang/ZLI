import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@zli-v2/ui/tokens.css";
import { rootView } from "./rootView.js";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing #root element for the ZLI renderer.");

createRoot(rootElement).render(<StrictMode>{rootView(window.location.search)}</StrictMode>);
