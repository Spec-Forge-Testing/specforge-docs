# Tests de Integración — `core_ast`

Este directorio contiene una única suite de integración orientada a pruebas
manuales/locales sobre repositorios reales.

## Resumen rápido

- El único archivo de tests es `test_pipeline_stages.py`. Edita `REPO_CONFIG` en ese
  archivo para apuntar a cualquier repo local y endpoint que quieras testear.
- Alternativamente exporta la variable de entorno `INTEGRATION_REPO` para anular
  la ruta al repo al ejecutar `pytest`.
- El test genera un directorio `tests/integration/output/` donde deja un archivo
  por etapa (`01_locator.txt` ... `05_quality.txt`) y el bundle final `output.py`.

## Cómo configurar la repo a testear

1. Edita `lib/core_ast/tests/integration/test_pipeline_stages.py` y cambia
   `REPO_CONFIG["repo_path"]` al path absoluto de tu repo local.

2. (Opcional) En lugar de editar el archivo puedes exportar la variable de entorno:

```bash
export INTEGRATION_REPO=/home/you/projects/my-service
pytest -m integration -q
```

## Salida y ubicación

- Archivos por etapa: `lib/core_ast/tests/integration/output/01_locator.txt`, ...
- Bundle final: `lib/core_ast/tests/integration/output/output.py`

## Notas

- Estos tests son manuales y no forman parte del CI. Están pensados para iteración
  local rápida y debug en proyectos reales.
