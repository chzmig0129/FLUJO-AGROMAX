# AgroMax — Ingesta, Probe y Transcripción (Etapas 1-3)

AgroMax es un pipeline que convierte video crudo en un curso online. Este repositorio implementa las primeras **tres etapas**:

1. **Ingesta**: recibe un ZIP de videos crudos, lo extrae y analiza cada archivo con `ffprobe`.
2. **Probe**: mide metadata técnica determinista de cada video (resolución, fps, codec, audio) y decide si necesitará transcodificación.
3. **Transcripción**: transcribe cada video con Whisper (motor intercambiable), con timestamps por palabra, detecta si el clip tiene narración real o es B-roll mudo, y arma un resumen legible del proyecto completo.

Las etapas siguientes del pipeline (edición, generación del curso, publicación, etc.) todavía no existen y no forman parte de este repo.

Es una app Next.js full-stack, sin base de datos y sin autenticación: el estado de cada job vive en el filesystem, en `jobs/<id>/`.

## Requisitos

- Node.js 20 o superior.
- Python 3.12 y [`uv`](https://docs.astral.sh/uv/) para el motor de transcripción (ver [Setup del motor de transcripción](#setup-del-motor-de-transcripción)).

No hace falta instalar `ffmpeg` ni `ffprobe` a mano: vienen empaquetados como dependencias de npm (`ffmpeg-static` y `ffprobe-static`) y se instalan junto con el resto del proyecto.

## Instalación

```bash
npm install
bash scripts/setup-python.sh
```

`npm install` alcanza para correr la app (ingesta + probe). El script de Python es necesario para que la etapa 3 (transcripción) funcione con el motor por defecto (`mlx-whisper`, macOS/Apple Silicon) — ver detalles abajo.

## Correr la app

```bash
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000) en el navegador.

## Flujo de uso

No hay input manual más allá de subir el ZIP: no se pide nombre de proyecto, ni orden, ni títulos. El pipeline corre de punta a punta automáticamente.

1. **Subir** (`/`): el usuario sube un archivo ZIP con los videos crudos. El nombre del proyecto (`job.name`) se deriva automáticamente del nombre del archivo ZIP (sin la extensión `.zip`). Al confirmar, se crea `jobs/<id>/`, se extrae el ZIP a `source/`, se analiza cada video con `ffprobe` (etapa 1: ingesta), y se dispara en background el resto del pipeline (probe + transcripción). La respuesta redirige de inmediato a `/jobs/<id>`.
2. **Vista de job** (`/jobs/[jobId]`): pollea `GET /api/jobs/<id>` cada 2 segundos y muestra el progreso real en curso:
   - **Ingesta**: ya completa al llegar a esta pantalla.
   - **Probe** (`status: "probing"` → `"probed"`): midiendo metadata técnica de cada video.
   - **Transcripción** (`status: "transcribing"` → `"transcribed"`): progreso por archivo (pendiente/transcribiendo/hecho/error), leído de `progress/progress.json`.
   - Al llegar a `status: "transcribed"`: resumen del proyecto (cantidad de videos, duración total, cuáles quedaron marcados como "sin narración"), botón **"Re-transcribir"** (dispara `POST /api/jobs/<id>/transcribe` sin necesidad de volver a subir el ZIP) y botón para ver `master.txt` completo.
   - Si el pipeline falla en cualquier etapa, `status: "error"` y se muestra `job.errorMessage`.

## Estructura de `jobs/<id>/`

Cada job vive en su propia carpeta dentro de `jobs/`, identificada por un UUID:

```
jobs/
  <id>/
    source/              # videos extraídos del ZIP subido (el ZIP original NO se guarda aquí)
    job.json              # estado general del job y metadata de ingesta (etapa 1)
    probe/
      media.json           # metadata técnica por archivo, etapa 2
    transcripts/
      <base>.json           # transcripción completa de un archivo (segments + words con timestamps)
      <base>.tsv             # misma transcripción en TSV (start, end, text) para hojas de cálculo/subtítulos
      <base>.txt              # transcripción en texto plano legible
      master.txt                # resumen legible de TODOS los archivos del job, en el orden de probe/media.json
      summary.json               # resumen estructurado por archivo (narration, duración, status) — etapa 3
    progress/
      progress.json               # estado de transcripción por archivo en tiempo real (pending/running/done/error)
```

- **`source/` es inmutable**: el ZIP subido se guarda temporalmente como `jobs/<id>/upload.zip`, se extrae a `source/` y luego se borra — nunca queda dentro de `source/`. Ningún código de las etapas posteriores (probe, transcripción) escribe, mueve ni borra nada dentro de `source/`; solo lo leen. Esta invariante está documentada en `src/lib/jobs.ts`.

- **`job.json`** — estado del job a través de las tres etapas. El tipo `JobStatus` define: `"ingested"` (ZIP extraído y analizado, etapa 1 lista) → `"probing"` → `"probed"` (etapa 2 lista) → `"transcribing"` → `"transcribed"` (etapa 3 lista) → `"error"` (falla irrecuperable en cualquier etapa, con `errorMessage`). También acumula `stages.probe`/`stages.transcribe` con `startedAt`/`finishedAt` de cada corrida. Ejemplo:

  ```json
  {
    "id": "3fa1c2b0-1234-4abc-9def-abcdef123456",
    "name": "Curso de riego por goteo",
    "status": "transcribed",
    "stage": "ingest",
    "createdAt": "2026-07-20T10:00:00.000Z",
    "updatedAt": "2026-07-20T10:12:00.000Z",
    "config": {},
    "files": [
      {
        "filename": "clip1.mp4",
        "durationSeconds": 132.4,
        "hasAudio": true,
        "width": 1920,
        "height": 1080,
        "issues": []
      },
      {
        "filename": "clip2.mov",
        "durationSeconds": 0,
        "hasAudio": false,
        "width": 0,
        "height": 0,
        "issues": ["zero_duration", "no_audio"]
      }
    ],
    "stages": {
      "probe": { "startedAt": "2026-07-20T10:05:00.000Z", "finishedAt": "2026-07-20T10:05:10.000Z" },
      "transcribe": { "startedAt": "2026-07-20T10:05:10.000Z", "finishedAt": "2026-07-20T10:12:00.000Z" }
    }
  }
  ```

  Si algo falla durante la ingesta misma (etapa 1, antes de que exista `job.json`), se borra el directorio completo del job en vez de dejarlo a medio crear. `issues` de cada archivo puede contener `"not_a_video"`, `"zero_duration"` y/o `"no_audio"`.

- **`probe/media.json`** — metadata técnica por archivo, generada por `ffprobe` en la etapa 2 (`src/lib/probe-stage.ts`), en el mismo orden alfabético (`localeCompare`) que se lee `source/`. Ejemplo:

  ```json
  [
    {
      "filename": "clip1.mp4",
      "width": 1920,
      "height": 1080,
      "fps": 29.97,
      "videoCodec": "h264",
      "durationSeconds": 132.4,
      "audioChannels": 2,
      "audioSampleRate": 48000,
      "needsTranscode": false
    }
  ]
  ```

  `needsTranscode` es `true` si el lado mayor de la imagen supera 1920px, el lado menor supera 1080px, o el framerate supera 30fps (cubre tanto horizontales como verticales, usando lado mayor/menor en vez de width/height fijos). Hoy la etapa solo registra el dato; la decisión de transcodificar la toma una etapa futura del pipeline.

- **`transcripts/`** — salida de la etapa 3 (`src/lib/transcribe/`). Por cada archivo de `source/` (excepto los que fallan) se generan tres formatos hermanos con el mismo nombre base (`<filename sin extensión>`):
  - **`<base>.json`** — el `TranscriptResult` completo: `language`, `durationSeconds`, `segments` (cada uno con `start`, `end`, `text` y su desglose de `words`, con timestamp por palabra), y `narration` (booleano).
  - **`<base>.tsv`** — mismos segmentos en formato `start\tend\ttext`, para hojas de cálculo o edición de subtítulos.
  - **`<base>.txt`** — el texto de los segmentos, en párrafos, legible por humanos.
  - **`master.txt`** — un único documento que junta, en el orden de `probe/media.json`, el resultado de todos los archivos del job (encabezado `=== archivo (mm:ss) ===`, nota `(clip sin narración)` cuando corresponde, y el texto transcrito o `(error de transcripción)` si ese archivo falló).
  - **`summary.json`** — resumen estructurado por archivo: `{ files: [{ filename, narration, durationSeconds, status }] }`, usado por la API/UI para armar el resumen final sin tener que parsear `master.txt`.

- **`progress/progress.json`** — estado de transcripción en tiempo real por archivo, para que la UI pueda pollear el avance mientras el job corre: `{ files: { "<filename>": { status: "pending"|"running"|"done"|"error", error?: string } } }`. Se escribe en cada transición de estado durante la etapa 3.

## Setup del motor de transcripción

La transcripción (etapa 3) nunca corre transcripción Whisper directamente en Node: cada motor es un **script Python independiente** que Node invoca vía `spawn` y que imprime a stdout un único JSON normalizado (`{ language, duration, segments }`, con `words` por segmento). Esto permite intercambiar el motor sin tocar el código Node que lo consume — ver `src/lib/transcribe/types.ts`, `engine.ts` y `python-engine.ts`.

| Motor | Variable `TRANSCRIBE_ENGINE` | Script | Cuándo usarlo |
|---|---|---|---|
| mlx-whisper | `mlx` (default) | `scripts/transcribe_mlx.py` | Desarrollo local en macOS / Apple Silicon. |
| faster-whisper | `faster` | `scripts/transcribe_faster.py` | Producción en Windows/Linux con GPU NVIDIA. |

Ambos motores usan el modelo `large-v3-turbo` y devuelven exactamente el mismo contrato de salida.

### Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `TRANSCRIBE_ENGINE` | `mlx` | Motor a usar: `mlx` o `faster`. |
| `TRANSCRIBE_LANG` | `es` | Idioma pasado al motor de transcripción. |
| `TRANSCRIBE_CONCURRENCY` | `2` | Cantidad de archivos transcritos en simultáneo dentro de un mismo job. |
| `PYTHON_BIN` | `.venv-whisper/bin/python` | Ruta al intérprete Python usado para invocar los scripts de motor. |
| `TRANSCRIBE_TIMEOUT_MIN` | `60` | Minutos máximos permitidos para transcribir un solo archivo antes de abortarlo con error. |

### Setup local (macOS / Apple Silicon, motor `mlx` por defecto)

```bash
bash scripts/setup-python.sh
```

El script crea un entorno virtual dedicado en `.venv-whisper/` con `uv venv --python 3.12` e instala `mlx-whisper` con `uv pip install`. Requiere tener `uv` instalado. Es idempotente: si `.venv-whisper/` ya existe, lo reutiliza.

### Producción en Windows/NVIDIA (motor `faster`)

`mlx-whisper` es específico de Apple Silicon y no corre en Windows ni con GPU NVIDIA. Para esos entornos:

1. Instalar `faster-whisper` en el entorno Python que se vaya a usar (por ejemplo `pip install faster-whisper` dentro de un venv propio).
2. Configurar `TRANSCRIBE_ENGINE=faster` (y `PYTHON_BIN` apuntando al intérprete de ese entorno, si no es `.venv-whisper/bin/python`).

`faster-whisper` detecta automáticamente GPU disponible (`device="auto"`, `compute_type="auto"`), aprovechando NVIDIA cuando está presente.

## Detección de narración (anti-alucinación)

Whisper tiende a "alucinar" texto sobre silencio o ruido de fondo (frases genéricas tipo "Gracias por ver el video" incluso sin voz real), sobre todo en clips B-roll cortos y mudos (tomas de producto, paisajes, etc.). Marcarlos como "narrados" ensuciaría el resumen del proyecto.

Por eso la etapa 3 (`src/lib/transcribe/narration.ts`) combina dos señales antes de marcar `narration: true`:

1. **Sin pista de audio** (`audioChannels === 0` en `probe/media.json`): el motor Whisper ni siquiera se invoca para ese archivo — se escribe directamente un resultado vacío con `narration: false`. Un clip mudo es B-roll por definición, no algo a "transcribir", y Whisper no falla de forma limpia sobre silencio absoluto sino que alucina texto.
2. **Con audio**: se mide la energía global (RMS en dB) del clip con `ffmpeg` (filtro `astats`). Si el transcript resultante tiene un único segmento "sospechoso" (menos de 15 segundos de duración o menos de 80 caracteres de texto) **y** el audio está prácticamente en silencio (RMS por debajo de -45 dB, o no se pudo medir), se descarta como alucinación (`narration: false`). En cualquier otro caso (varios segmentos, o un segmento largo/con suficiente texto, o audio claramente audible) se considera narración real.

## Re-transcribir sin re-ingerir

Si el resultado de la transcripción no fue satisfactorio (por ejemplo tras cambiar `TRANSCRIBE_ENGINE` o `TRANSCRIBE_LANG`), se puede volver a correr probe + transcripción sobre un job ya existente sin tener que volver a subir el ZIP:

```bash
curl -X POST http://localhost:3000/api/jobs/<jobId>/transcribe
```

Este endpoint valida que el job exista (404 si no) y que no haya ya un pipeline corriendo en memoria para ese mismo job (409 si lo hay), y dispara `runPipeline` de nuevo en background. Es idempotente: sobreescribe `probe/media.json`, `transcripts/` y `progress/progress.json` desde cero. En la UI, el botón **"Re-transcribir"** de `/jobs/[jobId]` llama a este mismo endpoint.

## Estructura del código (`src/`)

- `src/lib/types.ts` — tipos compartidos de todo el pipeline (`JobJson`, `JobStatus`, `MediaInfo`, `ProgressJson`, etc.), usados por backend y UI.
- `src/lib/jobs.ts` — persistencia en filesystem de todo el job: `job.json`, `probe/media.json`, `progress/progress.json`, y las rutas de cada subdirectorio (`source/`, `probe/`, `transcripts/`, `progress/`). Documenta la invariante de `source/` inmutable.
- `src/lib/zip.ts` — extracción del ZIP subido hacia `jobs/<id>/source/`.
- `src/lib/probe.ts` — análisis inicial de cada video con `ffprobe` durante la ingesta (etapa 1: duración, audio, resolución, detección de problemas para `job.json`).
- `src/lib/probe-stage.ts` — etapa 2: vuelve a correr `ffprobe` sobre `source/` para obtener metadata técnica completa y escribe `probe/media.json`, incluyendo el criterio `needsTranscode`.
- `src/lib/pipeline.ts` — orquestador de las etapas 2 y 3 (`runPipeline`), pensado para correr en background (fire-and-forget) tras la ingesta o al re-transcribir. Deduplica corridas concurrentes del mismo job en memoria (`isPipelineRunning`).
- `src/lib/transcribe/index.ts` — etapa 3: recorre los archivos en el orden de `probe/media.json`, transcribe cada uno con el motor configurado (con un mini-pool de concurrencia sin dependencias nuevas), detecta narración, escribe `transcripts/` y actualiza `progress/progress.json` por archivo.
- `src/lib/transcribe/types.ts` — contrato TypeScript del motor de transcripción (`TranscribeEngine`, `TranscriptResult`, `TranscriptSegment`, `TranscriptWord`).
- `src/lib/transcribe/engine.ts` — selector de motor según `TRANSCRIBE_ENGINE` (`mlx` o `faster`).
- `src/lib/transcribe/python-engine.ts` — fábrica genérica que invoca cualquier script Python de motor vía `spawn`, parseando su JSON de stdout.
- `src/lib/transcribe/narration.ts` — heurística de detección de narración anti-alucinación (medición de energía de audio + forma del transcript).
- `src/lib/transcribe/writer.ts` — escritura de `<base>.json`/`.tsv`/`.txt` por archivo y de `master.txt` del job completo.
- `scripts/setup-python.sh` — crea `.venv-whisper/` e instala `mlx-whisper`.
- `scripts/transcribe_mlx.py` — script del motor `mlx-whisper` (macOS/Apple Silicon).
- `scripts/transcribe_faster.py` — script del motor `faster-whisper` (producción Windows/NVIDIA).
- `src/app/page.tsx` — pantalla única de subida: sube el ZIP (sin más input manual) y redirige a `/jobs/<id>`.
- `src/app/jobs/[jobId]/page.tsx` — vista de job: pollea el estado, muestra progreso por etapa y por archivo, y el resumen final con `master.txt` y el botón de re-transcribir.
- `src/app/api/ingest/route.ts` — recibe el ZIP, crea el job, corre la ingesta (etapa 1) y dispara `runPipeline` (etapas 2 y 3) en background.
- `src/app/api/jobs/[jobId]/route.ts` — expone `{ job, media, progress, summary }` de un job para que la UI pollee un único endpoint.
- `src/app/api/jobs/[jobId]/transcribe/route.ts` — re-corre el pipeline completo (probe + transcripción) sobre un job existente, sin re-ingerir.
- `src/app/api/jobs/[jobId]/master/route.ts` — sirve `transcripts/master.txt` como texto plano (404 si no existe todavía).
