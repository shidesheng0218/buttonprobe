# Model Provider Setup

ButtonProbe supports OpenAI-compatible `/chat/completions` endpoints and the native Anthropic Claude Messages API. API keys stay in environment variables and are never written to `buttonprobe.config.json`.

## Anthropic Claude

```bash
export BUTTONPROBE_PROVIDER=anthropic
export BUTTONPROBE_BASE_URL=https://api.anthropic.com
export ANTHROPIC_API_KEY=your-anthropic-key
export BUTTONPROBE_MODEL=claude-sonnet-5

npx buttonprobe fix http://localhost:5173 \
  --test-command "npm test" \
  --dev-command "npm run dev -- --host 127.0.0.1 --port {port}"
```

Or generate the configuration without storing the key:

```bash
npx buttonprobe init --provider anthropic
```

## OpenAI

```bash
export BUTTONPROBE_BASE_URL=https://api.openai.com/v1
export BUTTONPROBE_API_KEY=your-openai-key
export BUTTONPROBE_MODEL=gpt-4.1-mini
```

## DeepSeek

```bash
export BUTTONPROBE_BASE_URL=https://api.deepseek.com
export BUTTONPROBE_API_KEY=your-deepseek-key
export BUTTONPROBE_MODEL=deepseek-chat
```

## Ollama

```bash
export BUTTONPROBE_BASE_URL=http://localhost:11434/v1
export BUTTONPROBE_MODEL=your-local-model
```

## OpenRouter-Compatible

```bash
export BUTTONPROBE_BASE_URL=https://openrouter.ai/api/v1
export BUTTONPROBE_API_KEY=your-openrouter-key
export BUTTONPROBE_MODEL=your/provider-model
```

## Cost Controls

- `scan` never calls a model.
- `analyze` calls the model at most once per page.
- `fix` calls the model at most once per target control per round.
- Use `--no-images` for lower input cost.
- Use Ollama or DeepSeek for low-cost demos; use GPT- or Claude-class models when repair quality matters more than price.
