#!/usr/bin/env python3
"""
Motor de transcripción vía mlx-whisper (macOS / Apple Silicon).

Uso: python transcribe_mlx.py <video_path> <language>

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

import json
import sys


def log(msg: str) -> None:
    """Escribe un mensaje de progreso/diagnóstico a stderr."""
    print(msg, file=sys.stderr, flush=True)


def main() -> None:
    if len(sys.argv) < 3:
        log("Uso: transcribe_mlx.py <video_path> <language>")
        sys.exit(1)

    video_path = sys.argv[1]
    language = sys.argv[2]

    try:
        import mlx_whisper
    except ImportError:
        log(
            "mlx-whisper no está instalado; ejecuta scripts/setup-python.sh "
            "para crear el entorno de transcripción."
        )
        sys.exit(1)

    try:
        log(f"Transcribiendo '{video_path}' con mlx-whisper (idioma={language})...")
        result = mlx_whisper.transcribe(
            video_path,
            path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
            language=language,
            word_timestamps=True,
        )
    except Exception as exc:  # noqa: BLE001 - queremos capturar cualquier fallo del motor
        log(f"Error al transcribir con mlx-whisper: {exc}")
        sys.exit(1)

    raw_segments = result.get("segments", [])
    segments = []

    for seg in raw_segments:
        # Algunos segmentos pueden no traer palabras (silencios, etc.)
        raw_words = seg.get("words") or []
        words = [
            {
                "word": w["word"].strip(),
                "start": float(w["start"]),
                "end": float(w["end"]),
            }
            for w in raw_words
        ]

        segments.append(
            {
                "start": float(seg["start"]),
                "end": float(seg["end"]),
                "text": seg["text"].strip(),
                "words": words,
            }
        )

    duration = segments[-1]["end"] if segments else 0.0

    output = {
        "language": result.get("language", language),
        "duration": duration,
        "segments": segments,
    }

    log("Transcripción completada.")
    json.dump(output, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
