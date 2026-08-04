import { createServer } from "node:http";

const patch = `--- a/src/App.tsx
+++ b/src/App.tsx
@@ -12,17 +12,17 @@
       <p>Three controls are intentionally broken. One working control guards regressions.</p>
 
       <section aria-label="Broken controls">
-        <button data-testid="empty-onclick" onClick={() => {}}>
+        <button data-testid="empty-onclick" onClick={() => setEmptyFixed(true)}>
           Empty onClick
         </button>
         <span data-testid="empty-status">{emptyFixed ? "Fixed" : "Still dead"}</span>
 
-        <button data-testid="wrong-state" onClick={() => setCount(count)}>
+        <button data-testid="wrong-state" onClick={() => setCount((value) => value + 1)}>
           Wrong state update
         </button>
         <span data-testid="count-status">Count: {count}</span>
 
-        <button data-testid="missing-navigation" onClick={() => {}}>
+        <button data-testid="missing-navigation" onClick={() => setRoute("settings")}>
           Missing navigation
         </button>
         <span data-testid="route-status">Route: {route}</span>
`;

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const isAnalysis = body.includes("Analyze every supplied UI control");
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      choices: [
        {
          message: {
            content: isAnalysis
              ? JSON.stringify({
                  assessments: [
                    {
                      controlId: "empty-onclick",
                      expectedBehavior: "Mark the empty click as fixed",
                      observedBehavior: "The click produced no visible change",
                      verdict: "INERT",
                      confidence: 0.96,
                      explanation: "The handler is empty."
                    },
                    {
                      controlId: "wrong-state",
                      expectedBehavior: "Increment the counter",
                      observedBehavior: "The state is set to its current value",
                      verdict: "INERT",
                      confidence: 0.94,
                      explanation: "The state update is a no-op."
                    },
                    {
                      controlId: "missing-navigation",
                      expectedBehavior: "Navigate to settings",
                      observedBehavior: "The route state never changes",
                      verdict: "INERT",
                      confidence: 0.93,
                      explanation: "The handler is empty."
                    },
                    {
                      controlId: "normal-button",
                      expectedBehavior: "Save normally",
                      observedBehavior: "The status changes to Saved",
                      verdict: "WORKS",
                      confidence: 0.98,
                      explanation: "The working button is a regression guard."
                    }
                  ]
                })
              : JSON.stringify({
                  diagnosis: "Three demo buttons have missing or no-op click behavior.",
                  sourceConfidence: 0.98,
                  expectedOutcome: "The empty click marks fixed, the counter increments, and navigation changes route.",
                  patch,
                  affectedControls: ["empty-onclick", "wrong-state", "missing-navigation"],
                  risk: "low"
                })
          }
        }
      ],
      usage: { prompt_tokens: 1200, completion_tokens: 240 }
    })
  );
});

const port = Number(process.env.PORT ?? 11434);
server.listen(port, "127.0.0.1", () => {
  console.log(`ButtonProbe mock OpenAI-compatible endpoint: http://127.0.0.1:${port}/v1`);
});
