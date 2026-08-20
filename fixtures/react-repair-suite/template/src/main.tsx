import { useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

function RegressionGuard() {
  const [guard, setGuard] = useState("ready");
  return (
    <div>
      <button data-testid="regression-guard" onClick={() => setGuard("works")}>
        Regression guard
      </button>
      <span data-testid="regression-guard-status">{guard}</span>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div>
    <App />
    <RegressionGuard />
  </div>
);
