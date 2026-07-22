#!/usr/bin/env python3
"""
procesar_overlays.py — etapa 8a (segunda mitad) del pipeline: convierte cada
ilustración cruda `assets/overlays/raw/<key>.jpg` (fondo blanco liso, ver
`config/overlay-style.md`) en un PNG transparente con sombra suave, y
produce además un composite de chequeo sobre fondo gris oscuro (el insumo
real del Gate 1).

Uso: python procesar_overlays.py <jobDir>

Portado de
`/Users/chavez/Documents/AGROMAX/EDITOR/overlays/procesar_ilustraciones.py`:
flood-fill del blanco DESDE LOS BORDES (así se preserva cualquier blanco que
quede en el INTERIOR del dibujo, por ejemplo el fondo de una tarjeta o el
centro de una dona), trim a contenido y drop shadow suave. NO usa rembg
(sin red neuronal de segmentación): el algoritmo es determinista y barato.

ENTORNO REQUERIDO (mismo venv que gen_overlays.py):

    python -m venv .venv-overlays
    .venv-overlays/bin/pip install playwright pillow

(numpy es dependencia transitiva habitual de Pillow en entornos con
aceleración, pero acá se usa directamente para el flood-fill vectorizado;
si el venv no la trae, agregarla: `pip install numpy`.)

REANUDABLE: si `assets/overlays/final/<key>.png` ya existe para un
`raw/<key>.jpg`, ese key se salta.

SALIDA: log/progreso a stderr. Al final, UN único JSON a stdout:

    {"procesadas": int, "saltadas": int, "fallidas": [{"key": str, "error": str}]}
"""
import glob
import json
import os
import sys
from collections import deque

THRESH = 238  # un pixel se considera "fondo blanco" si los 3 canales >= THRESH
GATE1_BG = (60, 70, 60)  # gris oscuro sobre el que se compone qa/gate1-chk/


def log(msg: str) -> None:
    """Escribe un mensaje de progreso/diagnóstico a stderr."""
    print(msg, file=sys.stderr, flush=True)


def border_flood_alpha(rgb):
    """
    Flood-fill del blanco desde los BORDES de la imagen: solo el blanco
    conectado al borde se vuelve transparente (alpha=0). Cualquier blanco
    interior (ej. el centro de una dona, el fondo de una tarjeta) se
    preserva opaco (alpha=255) porque nunca fue visitado por el flood.
    """
    import numpy as np

    h, w, _ = rgb.shape
    white = np.all(rgb >= THRESH, axis=2)
    visited = np.zeros((h, w), bool)
    dq = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not visited[y, x]:
                visited[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not visited[y, x]:
                visited[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not visited[ny, nx] and white[ny, nx]:
                visited[ny, nx] = True
                dq.append((ny, nx))
    alpha = np.where(visited, 0, 255).astype(np.uint8)
    return alpha


def process_one(raw_path: str, final_path: str, gate1_chk_path: str) -> None:
    import numpy as np
    from PIL import Image, ImageFilter

    im = Image.open(raw_path).convert("RGB")
    rgb = np.asarray(im)
    alpha = border_flood_alpha(rgb)
    rgba = np.dstack([rgb, alpha])
    img = Image.fromarray(rgba, "RGBA")

    # Suaviza el borde de la máscara para matar dientes de sierra.
    a = img.split()[3].filter(ImageFilter.GaussianBlur(0.6))
    img.putalpha(a)

    # Recorta al contenido real (descarta el margen transparente sobrante).
    bbox = img.getbbox()
    if bbox is not None:
        img = img.crop(bbox)

    # Padding para dejar espacio a la sombra.
    pad = 60
    canvas = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))

    # Sombra suave a partir del canal alpha del propio recorte.
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    sh_a = Image.new("L", canvas.size, 0)
    sh_a.paste(img.split()[3], (pad, pad + 8))
    sh_a = sh_a.filter(ImageFilter.GaussianBlur(18))
    sh_a = sh_a.point(lambda v: int(v * 0.42))
    shadow_col = Image.new("RGBA", canvas.size, (10, 40, 22, 255))
    shadow.paste(shadow_col, (0, 0), sh_a)
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.alpha_composite(img, (pad, pad))

    os.makedirs(os.path.dirname(final_path), exist_ok=True)
    canvas.save(final_path)

    # Composite de chequeo (insumo del Gate 1): el PNG final sobre el gris
    # oscuro real que se usa en pantalla, para ver el overlay en su
    # contexto real sin depender del reproductor.
    bg = Image.new("RGB", canvas.size, GATE1_BG)
    bg.paste(canvas, (0, 0), canvas)
    os.makedirs(os.path.dirname(gate1_chk_path), exist_ok=True)
    bg.convert("RGB").save(gate1_chk_path, quality=90)


def main() -> None:
    if len(sys.argv) < 2:
        log("Uso: python procesar_overlays.py <jobDir>")
        sys.exit(1)

    job_dir = sys.argv[1]
    raw_dir = os.path.join(job_dir, "assets", "overlays", "raw")
    final_dir = os.path.join(job_dir, "assets", "overlays", "final")
    gate1_chk_dir = os.path.join(job_dir, "qa", "gate1-chk")

    procesadas = 0
    saltadas = 0
    fallidas = []

    for raw_path in sorted(glob.glob(os.path.join(raw_dir, "*.jpg"))):
        key = os.path.splitext(os.path.basename(raw_path))[0]
        final_path = os.path.join(final_dir, f"{key}.png")
        gate1_chk_path = os.path.join(gate1_chk_dir, f"{key}.jpg")

        if os.path.exists(final_path):
            log(f"↷ {key}: ya existe final/{key}.png, se salta (reanudable)")
            saltadas += 1
            continue

        try:
            log(f"→ {key} ...")
            process_one(raw_path, final_path, gate1_chk_path)
            log(f"  OK {final_path}")
            procesadas += 1
        except Exception as err:
            log(f"  FALLO {key}: {err}")
            fallidas.append({"key": key, "error": str(err)})

    print(json.dumps({"procesadas": procesadas, "saltadas": saltadas, "fallidas": fallidas}))


if __name__ == "__main__":
    main()
