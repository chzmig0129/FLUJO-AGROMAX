#!/usr/bin/env python3
"""
procesar_overlays.py — etapa 8a (segunda mitad) del pipeline: convierte cada
ilustración cruda `assets/overlays/raw/<key>.jpg` (fondo blanco liso, ver
`config/overlay-style.md`) en un PNG transparente con sombra suave, y
produce además un composite de chequeo sobre fondo gris oscuro (el insumo
real del Gate 1).

Uso: python procesar_overlays.py <jobDir>

Portado (y luego reescrito, ver `luminance_alpha`) de
`/Users/chavez/Documents/AGROMAX/EDITOR/overlays/procesar_ilustraciones.py`:
el canal alpha se deriva directamente de la luminancia de cada pixel
(tinta negra sobre papel claro → alpha = 1 - luminancia normalizada, con
piso/techo que satura), en vez de un flood-fill por conectividad+umbral:
así no depende de que el blanco esté "conectado" a un borde ni de que el
fondo sea uniforme, lo que evita tanto motas de halo blanco como erosión
del trazo. Trim a contenido y drop shadow suave. NO usa rembg (sin red
neuronal de segmentación): el algoritmo es determinista y barato.

ENTORNO REQUERIDO (mismo venv que gen_overlays.py):

    python -m venv .venv-overlays
    .venv-overlays/bin/pip install playwright pillow

(numpy es dependencia transitiva habitual de Pillow en entornos con
aceleración, pero acá se usa directamente para el modelo luminancia→alpha
vectorizado; si el venv no la trae, agregarla: `pip install numpy`.)

REANUDABLE: si `assets/overlays/final/<key>.png` ya existe para un
`raw/<key>.jpg`, ese key se salta.

SALIDA: log/progreso a stderr. Al final, UN único JSON a stdout:

    {"procesadas": int, "saltadas": int, "fallidas": [{"key": str, "error": str}]}
"""
import glob
import json
import os
import sys

# Umbrales del modelo luminancia→alpha (ver `luminance_alpha`): por debajo de
# DARK un pixel es tinta pura (alpha=255); por encima de LIGHT es papel puro
# (alpha=0); en el medio hay una rampa lineal (antialias suave, sin blanco
# sólido).
DARK = 190
LIGHT = 248
# Un pixel cuenta como "fondo confiable" (para estimar el piso local de papel)
# si su luminancia cruda supera este piso. La tinta de estas ilustraciones
# es mucho más oscura (percentiles bajos <30), así que este piso nunca
# confunde tinta con papel.
BG_SAMPLE_MIN = 150
BG_SIGMA = 45  # radio (px) de la estimación de fondo por convolución normalizada

GATE1_BG = (60, 70, 60)  # gris oscuro sobre el que se compone qa/gate1-chk/


def log(msg: str) -> None:
    """Escribe un mensaje de progreso/diagnóstico a stderr."""
    print(msg, file=sys.stderr, flush=True)


def estimate_background(l_arr):
    """
    Estima el "piso" local de papel (luminancia de fondo) en cada pixel,
    robusto a que ese fondo tenga viñeteado/textura Y a que esté rodeado
    de trazos de tinta gruesos (texto denso, rótulos).

    NO usa un filtro de máximo/ventana fija (MaxFilter): esa técnica falla
    justo detrás de bloques de texto anchos, porque si la ventana no
    alcanza a "ver" papel real más allá del texto, confunde tinta con
    fondo y el flat-field resultante queda mal calibrado ahí — esa fue la
    causa del halo blanco moteado "detrás de los rótulos" reportado por
    el juez.

    En su lugar hace una convolución normalizada (Nadaraya-Watson): solo
    los pixeles que ya son confiablemente papel (luminancia >= BG_SAMPLE_MIN)
    aportan al promedio ponderado por un blur gaussiano de radio BG_SIGMA;
    los pixeles de tinta aportan peso cero y no contaminan la estimación.
    Como el radio es generoso, la estimación "ve más allá" de bloques de
    texto anchos usando el papel real que los rodea, en vez de quedar
    bloqueada por ellos.
    """
    import numpy as np
    from PIL import Image, ImageFilter

    mask = l_arr >= BG_SAMPLE_MIN
    num_u8 = (l_arr * mask).astype(np.uint8)
    den_u8 = (mask.astype(np.uint8) * 255)
    num_blur = Image.fromarray(num_u8, mode="L").filter(ImageFilter.GaussianBlur(BG_SIGMA))
    den_blur = Image.fromarray(den_u8, mode="L").filter(ImageFilter.GaussianBlur(BG_SIGMA))
    num = np.asarray(num_blur, dtype=np.float32)
    den = np.asarray(den_blur, dtype=np.float32) / 255.0
    bg = num / np.clip(den, 1e-3, None)

    # Donde el peso es demasiado bajo (zona sin ningún pixel de fondo cerca,
    # caso extremo), recae en la mediana global del fondo detectado.
    weak = den < 0.05
    if weak.any():
        global_bg = float(np.median(l_arr[mask])) if mask.any() else 255.0
        bg = np.where(weak, global_bg, bg)
    return np.clip(bg, 1, 255)


def luminance_alpha(rgb):
    """
    Deriva el canal alpha DIRECTAMENTE de la luminancia corregida por el
    fondo local (ver `estimate_background`), sin flood-fill ni
    conectividad: alpha = rampa lineal de luminancia entre DARK (tinta,
    alpha=255) y LIGHT (papel, alpha=0).

    Este modelo es el correcto para "tinta negra sobre papel claro"
    (ver config/overlay-style.md) y es inmune tanto al ruido de fondo
    (que ya no depende de que un pixel esté "conectado" a un borde
    blanco, así que no quedan motas opacas sueltas) como a la erosión
    (no hay umbral binario duro: los bordes del trazo antialiasan
    suavemente en vez de morder el trazo o dejar halo sólido).
    """
    import numpy as np
    from PIL import Image

    l = np.asarray(Image.fromarray(rgb).convert("L")).astype(np.float32)
    bg = estimate_background(l)
    scale = 255.0 / bg
    flat = np.clip(rgb.astype(np.float32) * scale[:, :, None], 0, 255)
    l_flat = flat.mean(axis=2)
    alpha = np.clip((LIGHT - l_flat) / (LIGHT - DARK), 0.0, 1.0) * 255.0
    return alpha.astype(np.uint8)


def process_one(raw_path: str, final_path: str, gate1_chk_path: str) -> None:
    import numpy as np
    from PIL import Image, ImageFilter

    im = Image.open(raw_path).convert("RGB")
    rgb = np.asarray(im)
    alpha = luminance_alpha(rgb)
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
