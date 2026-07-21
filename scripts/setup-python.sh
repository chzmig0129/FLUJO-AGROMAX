#!/usr/bin/env bash
# Crea el entorno virtual de Python para el motor de transcripción mlx-whisper
# (macOS / Apple Silicon) e instala sus dependencias.
set -euo pipefail

# Nos posicionamos en la raíz del repo (un nivel arriba de scripts/).
cd "$(dirname "$0")/.."

VENV_DIR=".venv-whisper"

if [ ! -d "$VENV_DIR" ]; then
  echo "Creando entorno virtual en $VENV_DIR..."
  uv venv "$VENV_DIR" --python 3.12
else
  echo "El entorno virtual $VENV_DIR ya existe, se reutiliza."
fi

echo "Instalando mlx-whisper..."
uv pip install --python "$VENV_DIR/bin/python" mlx-whisper

echo "Listo: entorno de transcripción mlx-whisper preparado en $VENV_DIR."
