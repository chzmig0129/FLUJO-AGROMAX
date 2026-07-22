#!/usr/bin/env python3
"""
Motor de transcripción vía faster-whisper (producción Windows/NVIDIA).

Uso: python transcribe_faster.py <video_path> <language>

Imprime a stdout UN único JSON con el contrato normalizado:
{
  "language": str,
  "duration": float,
  "segments": [
    {"start": float, "end": float, "text": str,
     "words": [{"word": str, "start": float, "end": float}]}
  ]
}

Todo log/progreso se envía a stderr. En caso de error, exit code 1.
"""

import glob
import json
import os
import sys
import sysconfig


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


def main() -> None:
    if len(sys.argv) < 3:
        log("Uso: transcribe_faster.py <video_path> <language>")
        sys.exit(1)

    video_path = sys.argv[1]
    language = sys.argv[2]

    register_windows_nvidia_dlls()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        log(
            "faster-whisper no está instalado; este motor es para producción "
            "Windows/NVIDIA"
        )
        sys.exit(1)

    try:
        log(f"Cargando modelo faster-whisper large-v3-turbo...")
        model = WhisperModel("large-v3-turbo", device="auto", compute_type="auto")

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
    except Exception as exc:  # noqa: BLE001 - queremos capturar cualquier fallo del motor
        log(f"Error al transcribir con faster-whisper: {exc}")
        sys.exit(1)

    duration = segments[-1]["end"] if segments else 0.0

    output = {
        "language": getattr(info, "language", language),
        "duration": duration,
        "segments": segments,
    }

    log("Transcripción completada.")
    json.dump(output, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
