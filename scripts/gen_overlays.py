#!/usr/bin/env python3
"""
gen_overlays.py — etapa 8a del pipeline: genera las ILUSTRACIONES de un job
vía ChatGPT web (CDP, http://localhost:9222), a partir de los briefs
escritos en la etapa 7 (`plan/overlays/<lessonId>.json`).

Uso: python gen_overlays.py <jobDir>

Portado de la mecánica de scraping de
`/Users/chavez/Documents/AGROMAX/EDITOR/overlays/gen_ilustraciones.py`
(new_chat / type / esperar imagen generada / fetch blob), pero leyendo los
prompts de los briefs de esta etapa en vez de un diccionario fijo en el
código, y concatenando SIEMPRE el bloque de estilo obligatorio de
`config/overlay-style.md` (ver ese archivo) al final del `prompt` de cada
brief antes de enviarlo.

ENTORNO REQUERIDO (no viene con el resto del repo, es un venv aparte):

    python -m venv .venv-overlays
    .venv-overlays/bin/pip install playwright pillow
    .venv-overlays/bin/playwright install chromium   # (no estrictamente
        necesario para connect_over_cdp, pero playwright lo pide instalado)

Requiere además una ventana de Chrome real corriendo con:

    open -a "Google Chrome" --args --remote-debugging-port=9222

...y con una sesión de chatgpt.com ya iniciada en alguna pestaña — esto
solo es posible en la Mac donde corre ese Chrome (no en CI / headless).

REANUDABLE: si `assets/overlays/raw/<key>.jpg` ya existe, ese brief se
salta (no se vuelve a generar). Así una corrida interrumpida a mitad de
camino se puede relanzar sin repetir trabajo ni gastar cuota de más.

SALIDA: todo el log/progreso va a stderr. Al final, UN único JSON a stdout
con el resumen:

    {"generadas": int, "saltadas": int, "fallidas": [{"key": str, "error": str}]}

Si no se puede conectar al CDP (Chrome no está abierto con
--remote-debugging-port=9222), se imprime a stderr una línea que empieza
con "CDP_UNAVAILABLE:" y el proceso termina con exit code 2 — es el
marcador que `overlay-gen-stage.ts` usa para dar un mensaje de error claro
en vez del stacktrace crudo de playwright.
"""
import base64
import glob
import io
import json
import os
import sys
import time

CDP = "http://localhost:9222"
GEN_TIMEOUT = 180  # segundos de espera por imagen generada


def log(msg: str) -> None:
    """Escribe un mensaje de progreso/diagnóstico a stderr."""
    print(msg, file=sys.stderr, flush=True)


def resolve_repo_root(job_dir: str) -> str:
    """
    Resuelve la raíz del repo (para ubicar config/overlay-style.md):
    usa REPO_ROOT del entorno si está definida; si no, la deriva de
    `<jobDir>`, asumiendo el layout real `<repoRoot>/jobs/<jobId>`
    (dos niveles arriba de jobDir).
    """
    env_root = os.environ.get("REPO_ROOT")
    if env_root:
        return os.path.abspath(env_root)
    abs_job_dir = os.path.abspath(job_dir)
    # <repoRoot>/jobs/<jobId> -> subir dos niveles.
    return os.path.dirname(os.path.dirname(abs_job_dir))


def load_style(repo_root: str) -> str:
    """
    Extrae el bloque de estilo obligatorio (texto exacto a concatenar) del
    fence ``` dentro de la sección "## STYLE" de config/overlay-style.md.
    No reinterpreta ni reescribe ese texto: lo usa tal cual.
    """
    style_path = os.path.join(repo_root, "config", "overlay-style.md")
    with open(style_path, "r", encoding="utf-8") as f:
        content = f.read()

    marker = "## STYLE"
    idx = content.find(marker)
    if idx == -1:
        raise RuntimeError(f"No se encontró la sección '## STYLE' en {style_path}")

    after_marker = content[idx:]
    fence_start = after_marker.find("```")
    if fence_start == -1:
        raise RuntimeError(f"No se encontró el bloque ``` de estilo en {style_path}")
    fence_body_start = after_marker.find("\n", fence_start) + 1
    fence_end = after_marker.find("```", fence_body_start)
    if fence_end == -1:
        raise RuntimeError(f"Bloque ``` de estilo sin cerrar en {style_path}")

    style_text = after_marker[fence_body_start:fence_end].strip()
    if not style_text:
        raise RuntimeError(f"Bloque de estilo vacío en {style_path}")
    return style_text


def load_briefs(job_dir: str):
    """
    Lee TODOS los `plan/overlays/<lessonId>.json` del job y devuelve la
    lista plana de briefs `{key, fact, at_seconds, clip, prompt, aspect}`
    de todas las lecciones (el forma de archivo es
    `{lessonId, generatedAt, briefs: [...]}`, ver
    `.claude/commands/briefs-overlays.md`).
    """
    overlays_dir = os.path.join(job_dir, "plan", "overlays")
    briefs = []
    for path in sorted(glob.glob(os.path.join(overlays_dir, "*.json"))):
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        for brief in data.get("briefs", []):
            briefs.append(brief)
    return briefs


# --- Mecánica CDP/ChatGPT (portada de gen_ilustraciones.py) ----------------

def img_srcs(page):
    return page.eval_on_selector_all(
        "main img",
        "els => els.map(e => ({src:e.currentSrc||e.src, w:e.naturalWidth, alt:e.alt||''}))",
    )


def is_gen(s):
    src = s.get("src") or ""
    alt = s.get("alt") or ""
    if not (s.get("w") and s["w"] >= 400):
        return False
    return (
        alt.lower().startswith("generated image")
        or "estuary/content" in src
        or "oaiusercontent" in src
        or "id=file_" in src
        or src.startswith("blob:")
    )


def save_src(page, src, out):
    from PIL import Image

    du = page.evaluate(
        """async(u)=>{const r=await fetch(u);const b=await r.blob();
        return await new Promise(res=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.readAsDataURL(b);});}""",
        src,
    )
    Image.open(io.BytesIO(base64.b64decode(du.split(",", 1)[1]))).convert("RGB").save(
        out, quality=95
    )


def new_chat(page):
    if "chatgpt.com" not in page.url:
        page.evaluate("()=>window.location.assign('https://chatgpt.com/')")
    else:
        page.evaluate(
            """()=>{const a=[...document.querySelectorAll('a')].find(x=>x.getAttribute('href')==='/');
            if(a)a.click();else window.location.assign('https://chatgpt.com/');}"""
        )
    try:
        page.wait_for_selector("#prompt-textarea", state="visible", timeout=90000)
    except Exception:
        page.wait_for_selector("div[contenteditable='true']", state="visible", timeout=30000)
    page.wait_for_timeout(1500)


def gen(page, prompt, out):
    new_chat(page)
    comp = None
    for sel in ["#prompt-textarea", "div[contenteditable='true']", "textarea"]:
        if page.locator(sel).count():
            comp = page.locator(sel).first
            break
    before = {s["src"] for s in img_srcs(page) if is_gen(s)}
    comp.click()
    page.keyboard.type(prompt, delay=3)
    page.wait_for_timeout(300)
    page.keyboard.press("Enter")
    deadline = time.time() + GEN_TIMEOUT
    src = None
    while time.time() < deadline:
        cand = [s for s in img_srcs(page) if is_gen(s) and s["src"] not in before]
        if cand:
            src = cand[-1]["src"]
            break
        page.wait_for_timeout(2500)
    if not src:
        raise RuntimeError("no image (límite o UI)")
    save_src(page, src, out)


def main() -> None:
    if len(sys.argv) < 2:
        log("Uso: python gen_overlays.py <jobDir>")
        sys.exit(1)

    job_dir = sys.argv[1]
    repo_root = resolve_repo_root(job_dir)
    style = load_style(repo_root)

    briefs = load_briefs(job_dir)

    raw_dir = os.path.join(job_dir, "assets", "overlays", "raw")
    os.makedirs(raw_dir, exist_ok=True)

    generadas = 0
    saltadas = 0
    fallidas = []

    pending = []
    for brief in briefs:
        key = brief.get("key")
        if not key:
            continue
        out = os.path.join(raw_dir, f"{key}.jpg")
        if os.path.exists(out):
            log(f"↷ {key}: ya existe raw/{key}.jpg, se salta (reanudable)")
            saltadas += 1
            continue
        pending.append((key, brief, out))

    if not pending:
        print(json.dumps({"generadas": 0, "saltadas": saltadas, "fallidas": []}))
        return

    try:
        from playwright.sync_api import sync_playwright
    except ImportError as err:
        log(f"CDP_UNAVAILABLE: falta playwright en el entorno Python ({err})")
        sys.exit(2)

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.connect_over_cdp(CDP)
            except Exception as err:
                log(f"CDP_UNAVAILABLE: no se pudo conectar a {CDP} ({err})")
                sys.exit(2)

            ctx = browser.contexts[0]
            page = next((pg for pg in ctx.pages if "chatgpt.com" in pg.url), None) or (
                ctx.pages[0] if ctx.pages else ctx.new_page()
            )
            try:
                page.bring_to_front()
            except Exception:
                pass

            for key, brief, out in pending:
                full_prompt = f"{brief.get('prompt', '')} {style}"
                try:
                    log(f"→ {key} ...")
                    gen(page, full_prompt, out)
                    log(f"  OK {out}")
                    generadas += 1
                except SystemExit:
                    raise
                except Exception as err:
                    log(f"  FALLO {key}: {err}")
                    fallidas.append({"key": key, "error": str(err)})
                page.wait_for_timeout(4000)
    except SystemExit:
        raise

    print(
        json.dumps(
            {"generadas": generadas, "saltadas": saltadas, "fallidas": fallidas}
        )
    )


if __name__ == "__main__":
    main()
