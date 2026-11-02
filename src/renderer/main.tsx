import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { hasBridge, platform } from "./api";
import { App } from "./App";
import { BridgeMissing } from "./components/Overlays";
import { init } from "./store";
import "./styles/app.css";

document.documentElement.dataset.platform = platform;
const root = createRoot(document.getElementById("root")!);

if (!hasBridge) {
  root.render(<BridgeMissing />);
} else {
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  init().catch((e) => {
    console.error(e);
    root.render(<BridgeMissing />);
  });
}
