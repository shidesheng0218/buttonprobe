# Demo Script

1. Start `fixtures/viral-demo-react`.
2. Click the three broken buttons: empty onClick, wrong state update, missing navigation.
3. Run the mock OpenAI-compatible endpoint.
4. Run:

```bash
npx buttonprobe fix http://localhost:5173 --test-command "node src/App.test.mjs"
```

5. Show `.buttonprobe/repairs/<control-id>/verified.diff`.
6. Show the original checkout remains unchanged.
7. Re-run with `--apply` and show the repaired buttons working.
