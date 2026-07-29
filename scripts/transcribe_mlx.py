#!/usr/bin/env python3
"""
Motor de transcripción vía mlx-whisper (macOS / Apple Silicon).

Uso:
  python transcribe_mlx.py <video_path> <language>
  python transcribe_mlx.py --serve

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

En modo --serve, el proceso carga el modelo una única vez (mlx-whisper cachea
el modelo internamente entre llamadas dentro del mismo proceso) y luego lee
requests JSONL por stdin, uno por línea:
  {"videoPath": "...", "language": "es"}
Por cada request escribe a stdout UNA línea con el mismo contrato normalizado
de arriba, o {"error": "..."} si esa transcripción puntual falló (el proceso
sigue vivo para atender el siguiente request). EOF en stdin = salir con
código 0.

Todo log/progreso se envía a stderr. En modo posicional, error de
transcripción = exit code 1.
"""

import json
import sys


def log(msg: str) -> None:
    """Escribe un mensaje de progreso/diagnóstico a stderr."""
    print(msg, file=sys.stderr, flush=True)


def transcribe_one(video_path: str, language: str) -> dict:
    """Transcribe un único archivo y devuelve el dict normalizado.

    Puede lanzar cualquier excepción del motor subyacente; quien la invoque
    decide si eso aborta el proceso (modo posicional) o solo produce un
    {"error": ...} por esa transcripción puntual (modo --serve).
    """
    log(f"Transcribiendo '{video_path}' con mlx-whisper (idioma={language})...")
    result = mlx_whisper.transcribe(
        video_path,
        path_or_hf_repo="mlx-community/whisper-large-v3-turbo",
        language=language,
        word_timestamps=True,
    )

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
    return output


def serve_loop() -> None:
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
            output = transcribe_one(video_path, language)
            print(json.dumps(output, ensure_ascii=False), flush=True)
        except Exception as exc:  # noqa: BLE001 - un clip fallido no debe matar el loop
            log(f"Error al transcribir '{video_path}': {exc}")
            print(json.dumps({"error": str(exc)}, ensure_ascii=False), flush=True)

    log("EOF en stdin; saliendo del modo --serve.")


def main() -> None:
    args = sys.argv[1:]
    serve_mode = "--serve" in args
    positional = [a for a in args if a != "--serve"]

    global mlx_whisper
    try:
        import mlx_whisper  # noqa: PLC0415 - import diferido para dar mensaje claro
    except ImportError:
        log(
            "mlx-whisper no está instalado; ejecuta scripts/setup-python.sh "
            "para crear el entorno de transcripción."
        )
        sys.exit(1)

    if serve_mode:
        serve_loop()
        return

    if len(positional) < 2:
        log("Uso: transcribe_mlx.py <video_path> <language> | --serve")
        sys.exit(1)

    video_path, language = positional[0], positional[1]

    try:
        output = transcribe_one(video_path, language)
    except Exception as exc:  # noqa: BLE001 - queremos capturar cualquier fallo del motor
        log(f"Error al transcribir con mlx-whisper: {exc}")
        sys.exit(1)

    json.dump(output, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
