# semantic_inference

Motor de Inferencia Estructurada — Cerebro orquestador entre el análisis estático y la ejecución determinística.

Este módulo transforma el contexto puro extraído del código fuente (AST) y los contratos OpenAPI en invariantes matemáticos, límites de dominio y reglas de negocio ocultas. En lugar de depender de interacciones conversacionales libres, implementa un pipeline de inferencia estricta apoyado en una arquitectura multi-agente para alimentar dinámicamente al motor de Property-Based Testing.

## Configuración del Entorno

Para que el módulo y los tests de integración funcionen, el cliente necesita saber a qué modelo llamar y con qué credenciales autorizarse.

Dependiendo del modelo elegido, se deben configurar la variable `LLM_MODEL` y su respectiva API Key del `.env.local` (en la raíz del proyecto):

| Proveedor | Variable de Entorno | Modelo de ejemplo en código (`LLM_MODEL`) |
| :--- | :--- | :--- |
| **Google Gemini** | `GEMINI_API_KEY` | `gemini/gemini-1.5-pro`, `gemini/gemini-1.5-flash` |
| **Anthropic** | `ANTHROPIC_API_KEY` | `anthropic/claude-3-5-sonnet` |
| **OpenAI** | `OPENAI_API_KEY` | `openai/gpt-4o`, `openai/gpt-3.5-turbo` |
| **Mistral AI** | `MISTRAL_API_KEY` | `mistral/mistral-large-latest` |
| **Groq** *(Ultra veloz)* | `GROQ_API_KEY` | `groq/llama3-70b-8192` |

## Sobre los tests

Se incluyen dos niveles de validación:

* **Tests locales y unitarios**: Prueban la configuración, la carga de templates y el wrapper del cliente de forma aislada.
* **Smoke test de integración**: Hacen llamadas reales a las APIs de los modelos configurados (ej. enviar un "Ping" y esperar un "Pong").

    **Nota**: Los tests de integración (marcados con `@pytest.mark.integration`) no corren en el pipeline de GitHub Actions por defecto. Esto evita que los builds fallen aleatoriamente por problemas de red, falta de credenciales reales o caídas temporales en los servidores del proveedor.

Para correr solo los tests rápidos (sin integración):

```bash
python -m pytest -m "not integration" -q
```

Para probar exclusivamente el smoke test de conexión:

```bash
python -m pytest -m integration
```

Para correr la suite completa:

```bash
pytest
```
