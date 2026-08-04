import { useState } from "react";

export function App() {
  const [emptyFixed, setEmptyFixed] = useState(false);
  const [count, setCount] = useState(0);
  const [route, setRoute] = useState("home");
  const [normalSaved, setNormalSaved] = useState(false);

  return (
    <main>
      <h1>ButtonProbe viral repair demo</h1>
      <p>Three controls are intentionally broken. One working control guards regressions.</p>

      <section aria-label="Broken controls">
        <button data-testid="empty-onclick" onClick={() => {}}>
          Empty onClick
        </button>
        <span data-testid="empty-status">{emptyFixed ? "Fixed" : "Still dead"}</span>

        <button data-testid="wrong-state" onClick={() => setCount(count)}>
          Wrong state update
        </button>
        <span data-testid="count-status">Count: {count}</span>

        <button data-testid="missing-navigation" onClick={() => {}}>
          Missing navigation
        </button>
        <span data-testid="route-status">Route: {route}</span>
      </section>

      <section aria-label="Regression guard">
        <button data-testid="normal-button" onClick={() => setNormalSaved(true)}>
          Normal button
        </button>
        <span data-testid="normal-status">{normalSaved ? "Saved" : "Ready"}</span>
      </section>
    </main>
  );
}
