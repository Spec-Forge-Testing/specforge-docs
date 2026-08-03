# US-1: Router Multi-Modelo y Sistema de Fallback (LiteLLM)

Se integró un enrutador de modelos basado en **LiteLLM**, lo cual permite pivotar dinámicamente entre distintos proveedores (OpenAI, Anthropic, Gemini, Groq, Mistral) sin necesidad de refactorizar el código de consumo, garantizando una alta disponibilidad mediante una cadena de fallbacks automáticos y políticas de reintentos.

## Decisiones de Arquitectura

### 1. Centralización con LiteLLM
Uso de `litellm.completion` para todas las llamadas de inferencia, así se evitan SDKs propietarios directos, permitiendo que el sistema sea agnóstico al proveedor y facilitando la adición de nuevos modelos en el futuro.

### 2. Capa de Resiliencia (Retries & Fallbacks)
El sistema implementa un algoritmo de "espiral de reintentos" antes de saltar al siguiente modelo en la lista de fallbacks.
- **Retry:** Se aplica ante errores transitorios de red o retardos del servidor.
- **Fallback:** Se activa cuando el proveedor principal agota su cuota o tiene una caída crítica de servicio.

### 3. Clasificación de Errores

| Error | Causa Probable | Acción del Sistema |
| :--- | :--- | :--- |
| `AuthenticationError` | API Key inválida o vencida. | **Fail-Fast:** No reintenta. Corta la ejecución para evitar fallos silenciosos. |
| `RateLimitError` (429) | Agotamiento de créditos o cuota. | **Fallback:** Cambia inmediatamente al siguiente proveedor de la lista. |
| `ServiceUnavailable` (500) | Caída del servidor del proveedor. | **Fallback:** Intenta con el siguiente proveedor disponible. |
| `Timeout` | El modelo tarda en responder. | **Retry:** Reintenta con el mismo modelo esperando un tiempo exponencial. |

## Sobre el logging

El logging de fallback ya está implementado con `logging.warning`, pero para verlo claramente en una app real después conviene que el entrypoint del módulo o del servicio configure handlers/formato de logging. La lógica ya está; lo que faltaría más adelante es una configuración global de logs del proyecto.
