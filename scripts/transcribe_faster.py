#!/usr/bin/env python3
"""
Motor de transcripción vía faster-whisper (producción Windows/NVIDIA).

Uso:
  python transcribe_faster.py <video_path> <language>
  python transcribe_faster.py --serve

En el modo posicional, imprime a stdout UN único JSON con el contrato
normalizado:
{
  "language": str,
  "duration": float,
  "segments": [
    {"start": float, "end": float, "text": str,
     "words": [{"word": str, "start": float, "end": float}]}
  ]
}

En modo --serve, el proceso carga el modelo una única vez y luego lee
requests JSONL por stdin, uno por línea:
  {"videoPath": "...", "language": "es"}
Por cada request escribe a stdout UNA línea con el mismo contrato normalizado
de arriba, o {"error": "..."} si esa transcripción puntual falló (el proceso
sigue vivo para atender el siguiente request). EOF en stdin = salir con
código 0.

Dispositivo (device): se resuelve así, en orden de precedencia:
  1) WHISPER_DEVICE=cpu|cuda|auto (env explícito, siempre gana).
  2) En Windows (sys.platform == "win32"): 'cuda' por defecto (ya NO se
     degrada a CPU en silencio: si CUDA/cuDNN no cargan, el proceso aborta
     con un mensaje claro).
  3) Cualquier otra plataforma: 'auto' (comportamiento previo).

Todo log/progreso se envía a stderr. En modo posicional, error de
transcripción = exit code 1.
"""

import glob
import json
import os
import sys
import sysconfig

# En Windows, el stdout/stderr heredado del proceso puede quedar en el
# codepage local (p.ej. cp1252) en vez de UTF-8, lo que destruye acentos al
# ser leídos por python-engine.ts. Forzamos UTF-8 explícitamente en ambos
# streams (posicional y --serve). reconfigure existe desde Python 3.7; el
# hasattr es solo defensivo por si corre en un intérprete más viejo.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")


def log(msg: str) -> None:
    """Escribe un mensaje de progreso/diagnóstico a stderr."""
    print(msg, file=sys.stderr, flush=True)


def register_windows_nvidia_dlls() -> None:
    """En Windows, registra los directorios bin de los paquetes nvidia-*
    instalados por pip dentro del venv (Lib\\site-packages\\nvidia\\<paquete>\\bin)
    vía os.add_dll_directory, ya que ctranslate2/faster-whisper cargan
    cublas64_12.dll y las DLLs de cudnn en runtime y pip no las deja en PATH.
    No-op en plataformas distintas de Windows.
    """
    if sys.platform != "win32":
        return

    try:
        purelib = sysconfig.get_paths()["purelib"]
    except Exception as exc:  # noqa: BLE001 - no debe romper el arranque
        log(f"No se pudo resolver purelib para DLLs nvidia: {exc}")
        return

    pattern = os.path.join(purelib, "nvidia", "*", "bin")
    bin_dirs = [d for d in glob.glob(pattern) if os.path.isdir(d)]

    if not bin_dirs:
        log("No se encontraron paquetes nvidia en el venv; se usará CUDA del sistema si existe")
        return

    for bin_dir in bin_dirs:
        try:
            os.add_dll_directory(bin_dir)  # type: ignore[attr-defined]
            os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")
            log(f"Registrado directorio de DLLs nvidia: {bin_dir}")
        except Exception as exc:  # noqa: BLE001 - un dir malo no debe abortar el resto
            log(f"No se pudo registrar directorio de DLLs nvidia '{bin_dir}': {exc}")


def resolve_device() -> str:
    """Resuelve el device a usar según WHISPER_DEVICE (explícito, siempre
    gana) y, si no está seteado, según la plataforma: 'cuda' por defecto en
    Windows (producción NVIDIA), 'auto' en el resto."""
    env_device = os.environ.get("WHISPER_DEVICE", "").strip().lower()
    if env_device in ("cpu", "cuda", "auto"):
        return env_device

    if sys.platform == "win32":
        return "cuda"

    return "auto"


def load_model(whisper_model_cls):
    """Carga el modelo faster-whisper UNA vez. Si el device resuelto es
    'cuda' explícito y CUDA/cuDNN no logran inicializar, aborta el proceso
    con un mensaje claro (nada de degradar a CPU en silencio)."""
    device = resolve_device()
    log(f"Cargando modelo faster-whisper large-v3-turbo (device={device})...")

    try:
        model = whisper_model_cls("large-v3-turbo", device=device, compute_type="auto")
    except Exception as exc:  # noqa: BLE001 - queremos diagnosticar el fallo de CUDA
        if device == "cuda":
            log(
                f"No se pudo inicializar CUDA para faster-whisper: {exc}. "
                "Verifica el driver NVIDIA y las DLLs de cuDNN/cuBLAS instaladas "
                "en el venv. Usa WHISPER_DEVICE=cpu para forzar CPU explícitamente "
                "si necesitas seguir sin GPU."
            )
            sys.exit(1)
        raise

    return model, device


def transcribe_one(model, video_path: str, language: str) -> dict:
    """Transcribe un único archivo con un modelo ya cargado y devuelve el
    dict normalizado. Puede lanzar cualquier excepción del motor
    subyacente; quien la invoque decide si eso aborta el proceso (modo
    posicional) o solo produce un {"error": ...} por esa transcripción
    puntual (modo --serve)."""
    try:
        batch_size = int(os.environ.get("WHISPER_BATCH_SIZE", "8"))
    except ValueError:
        batch_size = 8

    raw_segments = None
    info = None
    if batch_size > 1:
        try:
            from faster_whisper import BatchedInferencePipeline

            pipeline = BatchedInferencePipeline(model=model)
            log(
                f"Transcribiendo '{video_path}' (idioma={language}, "
                f"batch_size={batch_size})..."
            )
            raw_segments, info = pipeline.transcribe(
                video_path,
                language=language,
                word_timestamps=True,
                batch_size=batch_size,
            )
        except Exception as exc:  # noqa: BLE001 - fallback a camino no batcheado
            log(
                f"BatchedInferencePipeline no disponible/falló ({exc}); "
                "usando transcripción no batcheada"
            )
            raw_segments = None
            info = None

    if raw_segments is None:
        log(f"Transcribiendo '{video_path}' (idioma={language})...")
        raw_segments, info = model.transcribe(
            video_path,
            language=language,
            word_timestamps=True,
        )

    segments = []
    # segments es un generador: hay que consumirlo por completo
    for seg in raw_segments:
        raw_words = seg.words or []
        words = [
            {
                "word": w.word.strip(),
                "start": float(w.start),
                "end": float(w.end),
            }
            for w in raw_words
        ]

        segments.append(
            {
                "start": float(seg.start),
                "end": float(seg.end),
                "text": seg.text.strip(),
                "words": words,
            }
        )

    duration = segments[-1]["end"] if segments else 0.0

    output = {
        "language": getattr(info, "language", language),
        "duration": duration,
        "segments": segments,
    }

    log("Transcripción completada.")
    return output


def serve_loop(model) -> None:
    """Loop persistente: lee un request JSON por línea de stdin y responde
    una línea JSON por stdout. EOF en stdin termina el loop (exit 0)."""
    log("Modo --serve listo; esperando requests JSONL por stdin...")

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        try:
            request = json.loads(line)
            video_path = request["videoPath"]
            language = request.get("language", "es")
        except Exception as exc:  # noqa: BLE001 - request malformado no debe matar el loop
            print(json.dumps({"error": f"request inválido: {exc}"}), flush=True)
            continue

        try:
            output = transcribe_one(model, video_path, language)
            print(json.dumps(output, ensure_ascii=True), flush=True)
        except Exception as exc:  # noqa: BLE001 - un clip fallido no debe matar el loop
            log(f"Error al transcribir '{video_path}': {exc}")
            print(json.dumps({"error": str(exc)}, ensure_ascii=True), flush=True)

    log("EOF en stdin; saliendo del modo --serve.")


def main() -> None:
    args = sys.argv[1:]
    serve_mode = "--serve" in args
    positional = [a for a in args if a != "--serve"]

    register_windows_nvidia_dlls()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log(
            "faster-whisper no está instalado; este motor es para producción "
            "Windows/NVIDIA"
        )
        sys.exit(1)

    if serve_mode:
        try:
            model, _device = load_model(WhisperModel)
        except SystemExit:
            raise
        except Exception as exc:  # noqa: BLE001 - no debe quedar un proceso a medio cargar
            log(f"No se pudo cargar el modelo faster-whisper: {exc}")
            sys.exit(1)
        serve_loop(model)
        return

    if len(positional) < 2:
        log("Uso: transcribe_faster.py <video_path> <language> | --serve")
        sys.exit(1)

    video_path, language = positional[0], positional[1]

    try:
        model, _device = load_model(WhisperModel)
        output = transcribe_one(model, video_path, language)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - queremos capturar cualquier fallo del motor
        log(f"Error al transcribir con faster-whisper: {exc}")
        sys.exit(1)

    json.dump(output, sys.stdout, ensure_ascii=True)


if __name__ == "__main__":
    main()
