# LLM Providers

`lib/semantic_inference/` expects model credentials depending on the provider you use.
Set `LLM_MODEL` and the matching API key in your environment (`.env.local` at the
repository root) before running inference tests.

| Provider      | Environment Variable | Example Model                  |
| ------------- | --------------------- | -------------------------------- |
| Google Gemini | `GEMINI_API_KEY`      | `gemini/gemini-1.5-pro`          |
| Anthropic     | `ANTHROPIC_API_KEY`   | `anthropic/claude-3-5-sonnet`    |
| OpenAI        | `OPENAI_API_KEY`      | `openai/gpt-4o`                  |
| Mistral AI    | `MISTRAL_API_KEY`     | `mistral/mistral-large-latest`   |
| Groq          | `GROQ_API_KEY`        | `groq/llama3-70b-8192`           |

Only the credential matching the configured `LLM_MODEL` is required — you don't
need every provider's key at once.
