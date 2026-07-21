# AgroMax — Ingesta, Probe, Transcripción, Muestreo de Frames, Plan autónomo y Preparación de corte (Etapas 1-5)

AgroMax es un pipeline que convierte video crudo en un curso online. Este repositorio implementa las primeras **cinco etapas**:

1. **Ingesta**: recibe un ZIP de videos crudos, lo extrae y analiza cada archivo con `ffprobe`.
2. **Probe**: mide metadata técnica determinista de cada video (resolución, fps, codec, audio) y decide si necesitará transcodificación.
3. **Transcripción**: transcribe cada video con Whisper (motor intercambiable), con timestamps por palabra, detecta si el clip tiene narración real o es B-roll mudo, y arma un resumen legible del proyecto completo.
3.5. **Muestreo de frames**: extrae JPGs de referencia de cada clip con `ffmpeg`, con una estrategia de muestreo distinta según el clip tenga narración o sea B-roll, y arma un manifest por job listo para que la etapa 4 elija qué frames usar.
4. **Plan (filtro editorial y estructura autónoma)**: un agente Claude autónomo (sin aprobación humana en el camino) lee la transcripción completa y los frames de referencia, decide un veredicto por clip (`leccion`/`broll`/`descartar`/`otro_curso`), arma la estructura del curso (módulos → lecciones → segmentos, cada lección con un `kind` `demo`/`normal`) y escribe un registro de auditoría completo para revisión humana **posterior**. Ver [Etapa 4: agente de plan autónomo](#etapa-4-agente-de-plan-autónomo).
5. **Preparación de corte (etapas 5A/5B/5C, deterministas, sin agente)**: sobre los clips que el agente clasificó como `leccion`, detecta silencio (`ffmpeg silencedetect`), genera proxies de edición 1080p30 y calcula cortes deterministas a partir de los huecos entre segmentos de la transcripción de Whisper. Ver [Etapa 5: preparación de corte (5A/5B/5C)](#etapa-5-preparación-de-corte-5a5b5c).

Las etapas siguientes del pipeline (edición, generación del curso, publicación, etc.) todavía no existen y no forman parte de este repo.

Es una app Next.js full-stack, sin base de datos y sin autenticación: el estado de cada job vive en el filesystem, en `jobs/<id>/`.

## Requisitos

- Node.js 20 o superior.
- Python 3.12 y [`uv`](https://docs.astral.sh/uv/) para el motor de transcripción (ver [Setup del motor de transcripción](#setup-del-motor-de-transcripción)).
- `ANTHROPIC_API_KEY` configurada en `.env.local` para que corra la etapa 4 (el agente de plan). Next.js carga `.env.local` automáticamente al `process.env` del server; sin esta variable, `runPlanStage` lanza un error explícito antes de intentar llamar a la API en vez de dejar que el SDK falle con un mensaje críptico de autenticación (`src/lib/plan-stage.ts`).

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
   - **Muestreo de frames** (`status: "sampling"` → `"sampled"`): extrayendo los JPGs de referencia de cada clip con `ffmpeg`. Jobs viejos que quedaron en `"transcribed"` sin `frames/manifest.json` (de antes de que existiera esta etapa) muestran en su lugar un botón **"Muestrear frames"** que dispara la etapa manualmente.
   - **Estructurando (agente)** (`status: "planning"` → `"planned"`): 5º paso del stepper, corriendo el agente autónomo de la etapa 4. Jobs que quedaron en `"sampled"` sin `plan/structure.json` (de antes de que existiera esta etapa) muestran en su lugar un botón **"Generar estructura (agente)"** que dispara la etapa manualmente (`POST /api/jobs/<id>/plan`).
   - Al llegar a `status: "planned"`: sección **AUDITORÍA** de solo lectura (sin controles de aprobación/bloqueo) con el árbol de estructura del curso, tarjetas de veredicto por clip (con confianza, razón, heurísticas citadas y frames), los apartados (`descartar`/`otro_curso`) y `plan/decisiones.md` renderizado; además botón **"Re-generar"** que vuelve a llamar a `POST /api/jobs/<id>/plan` sin re-transcribir ni re-muestrear. Ver [Etapa 4: agente de plan autónomo](#etapa-4-agente-de-plan-autónomo). En este estado (estable, previo a preparar) se muestra además el botón **"Preparar corte (silencio + proxies + cortes)"**.
   - **Preparando corte** (`status: "preparing"` → `"prepared"`): 6º paso del stepper, corriendo las etapas 5A/5B/5C. Mientras corre, muestra el sub-progreso de proxies (X/N clips) leído de `progress/prep-progress.json`. Al llegar a `status: "prepared"` se agrega la sección **"Preparación del corte"**: una tabla por clip con silencios detectados, segundos silentes y shrink % (con demos marcadas 🖐, sin recorte), y por lección la cantidad de cortes y duración cruda vs. proyectada, con un `<details>` expandible listando cada corte (frames + mm:ss + chip "✓ silencio" si `confirmedBySilence`). El botón pasa a **"Re-preparar corte"**. Ver [Etapa 5: preparación de corte (5A/5B/5C)](#etapa-5-preparación-de-corte-5a5b5c).
   - Al llegar a `status: "sampled"` (previo a planear): resumen del proyecto (cantidad de videos, duración total, cuáles quedaron marcados como "sin narración"), botones **"Re-transcribir"** (`POST /api/jobs/<id>/transcribe`, vuelve a correr probe + transcripción + frames) y **"Re-muestrear frames"** (`POST /api/jobs/<id>/frames`, solo re-corre la etapa 3.5), botón para ver `master.txt` completo, y una sección **"Frames por clip"** con la galería de miniaturas generadas (ver [Estructura de `jobs/<id>/`](#estructura-de-jobsid)).
   - Si el pipeline falla en cualquier etapa, `status: "error"` y se muestra `job.errorMessage`. Si ya existe `plan/structure.json` (los prerequisitos reales de la preparación), se ofrece además **"Reintentar preparación"** sin re-planear.

## Estructura de `jobs/<id>/`

Cada job vive en su propia carpeta dentro de `jobs/`, identificada por un UUID:

```
jobs/
  <id>/
    source/              # videos extraídos del ZIP subido (el ZIP original NO se guarda aquí)
    job.json              # estado general del job y metadata de ingesta (etapa 1)
    probe/
      media.json           # metadata técnica por archivo, etapa 2
      silence.json          # intervalos de silencio por clip 'leccion', etapa 5A
    transcripts/
      <base>.json           # transcripción completa de un archivo (segments + words con timestamps)
      <base>.tsv             # misma transcripción en TSV (start, end, text) para hojas de cálculo/subtítulos
      <base>.txt              # transcripción en texto plano legible
      master.txt                # resumen legible de TODOS los archivos del job, en el orden de probe/media.json
      summary.json               # resumen estructurado por archivo (narration, duración, status) — etapa 3
    progress/
      progress.json               # estado de transcripción por archivo en tiempo real (pending/running/done/error)
      prep-progress.json           # estado de generación de proxies por clip en tiempo real, etapas 5A/5B/5C
    frames/
      manifest.json                # resultado del muestreo: clips + frames extraídos, etapa 3.5
      <clip sin extensión>/
        frame_SSSS.jpg               # JPGs extraídos, ancho 640px, nombrados por segundo (SSSS con padding a 4 dígitos)
    plan/
      verdicts.json                 # un veredicto por clip (leccion/broll/descartar/otro_curso), etapa 4
      structure.json                  # módulos → lecciones → segments del curso principal + apartados (con `kind` por lección), etapa 4
      audit.json                        # registro de auditoría: modelo, usage, llamadas a frames extra, veredictos con lowConfidence, etapa 4
      decisiones.md                       # explicación en Markdown de las decisiones del agente, baja confianza primero, etapa 4
      cuts/
        <lessonId>.json                     # cortes deterministas por lección (huecos de Whisper), etapa 5C
    assets/
      proxies/
        <clip sin extensión>.mp4  # proxy de edición 1080p30 h264/aac por clip 'leccion', etapa 5B
```

- **`source/` es inmutable**: el ZIP subido se guarda temporalmente como `jobs/<id>/upload.zip`, se extrae a `source/` y luego se borra — nunca queda dentro de `source/`. Ningún código de las etapas posteriores (probe, transcripción, muestreo de frames) escribe, mueve ni borra nada dentro de `source/`; solo lo leen. Esta invariante está documentada en `src/lib/jobs.ts` y se repite explícitamente en `src/lib/frames-stage.ts`.

- **`job.json`** — estado del job a través de las seis etapas. El tipo `JobStatus` define: `"ingested"` (ZIP extraído y analizado, etapa 1 lista) → `"probing"` → `"probed"` (etapa 2 lista) → `"transcribing"` → `"transcribed"` (etapa 3 lista) → `"sampling"` → `"sampled"` (etapa 3.5 lista, `frames/` y `frames/manifest.json` generados) → `"planning"` → `"planned"` (etapa 4 lista, `plan/` completo) → `"preparing"` → `"prepared"` (etapas 5A/5B/5C listas, `probe/silence.json`, `assets/proxies/` y `plan/cuts/` generados) → `"error"` (falla irrecuperable en cualquier etapa, con `errorMessage`). También acumula `stages.probe`/`stages.transcribe`/`stages.frames`/`stages.plan`/`stages.silence`/`stages.proxies`/`stages.cuts` con `startedAt`/`finishedAt` de cada corrida. Ejemplo:

  ```json
  {
    "id": "3fa1c2b0-1234-4abc-9def-abcdef123456",
    "name": "Curso de riego por goteo",
    "status": "sampled",
    "stage": "ingest",
    "createdAt": "2026-07-20T10:00:00.000Z",
    "updatedAt": "2026-07-20T10:14:00.000Z",
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
      "transcribe": { "startedAt": "2026-07-20T10:05:10.000Z", "finishedAt": "2026-07-20T10:12:00.000Z" },
      "frames": { "startedAt": "2026-07-20T10:12:00.000Z", "finishedAt": "2026-07-20T10:14:00.000Z" }
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

- **`frames/`** — salida de la etapa 3.5 (`src/lib/frames-stage.ts`): un JPG por timestamp muestreado de cada clip de `source/`, más `frames/manifest.json` con el resultado estructurado. Se borra y recrea por completo en cada corrida (`fs.rm` + `fs.mkdir`), así que re-muestrear es idempotente y nunca deja JPGs de una estrategia anterior. Los JPGs se generan con `ffmpeg -vf scale=640:-2` (ancho fijo 640px, alto proporcional) y viven en `frames/<clip sin extensión>/frame_SSSS.jpg`, donde `SSSS` es el segundo del video del que se extrajo (con padding a 4 dígitos, por ejemplo `frame_0090.jpg` para el segundo 90).

  **Estrategia de muestreo** — por cada clip, según `narration` (calculado por la etapa 3 y leído de `transcripts/summary.json`):

  | Tipo de clip | Timestamps muestreados | Por qué |
  |---|---|---|
  | Narrado (`narration: true`) | 4 puntos fijos: 15%, 40%, 65% y 90% de la duración | Cubren inicio, dos tercios intermedios y cierre del relato sin depender de dónde caigan los cortes de frase; con narración el contenido relevante está distribuido a lo largo de todo el clip, así que alcanza con puntos de referencia dispersos. |
  | B-roll (`narration: false`) | Muestreo denso cada 4.5s, arrancando en t=2s y terminando en `duración - 0.5s`, con tope de 80 frames (`BROLL_MAX_FRAMES`) | Sin narración que guíe qué momento es relevante, hace falta más densidad para no perderse tomas útiles. Arranca en t=2 (no en 0) para evitar el frame negro/en blanco típico del primer instante del clip, y termina en `duración - 0.5` para evitar el frame de fade-out/corte abrupto del final. El tope de 80 evita generar cientos de JPGs de un B-roll de varios minutos. |

  **Fallback de clip vacío**: si el cálculo normal (narrado o B-roll) deja la lista de timestamps vacía —típico de un B-roll cortísimo cuya ventana `[2, duración-0.5]` no cabe, o de un narrado ultracorto— se cae al punto medio del clip (`duración / 2`) como único frame. Un clip sin ningún frame deja ciego al agente que consuma el manifest más adelante, que es justo lo que esta etapa existe para evitar: mejor 1 frame de compromiso que 0.

  Los timestamps se redondean a segundo entero (nombre de archivo y manifest usan enteros), se clampean a `Math.max(0, Math.floor(duración) - 1)` y se deduplican tras el clamp. El clamp existe porque `Math.round` puede sumar hasta +0.5s a un timestamp crudo: si ya estaba pegado al final del clip (ej. la ventana B-roll termina en `duración - 0.5`), el redondeo lo puede empujar a/pasado la duración total (24.5 → 25 en un clip de 25.0s), y `ffmpeg -ss` en/tras el EOF falla silenciosamente, descartando ese frame sin avisar. Un frame individual que falle al extraerse con `ffmpeg` (por ejemplo un timestamp fuera de rango en un clip más corto de lo reportado) se omite del manifest sin abortar el resto del clip ni del job.

  **`manifest.json`** — un objeto con `generatedAt` (ISO 8601, momento de esa corrida) y `clips` (un `ManifestClip` por archivo de `source/`, en el mismo orden que se procesaron). Cada `ManifestClip` trae `filename`, `narration`, `durationSeconds` (tomada de `probe/media.json` si existe, si no de `transcripts/summary.json`) y `frames` (lista de `{ timeSeconds, file }` ordenada por `timeSeconds`, donde `file` es la ruta relativa a `frames/`). Ejemplo:

  ```json
  {
    "generatedAt": "2026-07-20T10:14:00.000Z",
    "clips": [
      {
        "filename": "clip1.mp4",
        "narration": true,
        "durationSeconds": 132.4,
        "frames": [
          { "timeSeconds": 20, "file": "clip1/frame_0020.jpg" },
          { "timeSeconds": 53, "file": "clip1/frame_0053.jpg" },
          { "timeSeconds": 86, "file": "clip1/frame_0086.jpg" },
          { "timeSeconds": 119, "file": "clip1/frame_0119.jpg" }
        ]
      },
      {
        "filename": "clip2.mov",
        "narration": false,
        "durationSeconds": 25.0,
        "frames": [
          { "timeSeconds": 2, "file": "clip2/frame_0002.jpg" },
          { "timeSeconds": 7, "file": "clip2/frame_0007.jpg" },
          { "timeSeconds": 11, "file": "clip2/frame_0011.jpg" },
          { "timeSeconds": 16, "file": "clip2/frame_0016.jpg" },
          { "timeSeconds": 20, "file": "clip2/frame_0020.jpg" },
          { "timeSeconds": 24, "file": "clip2/frame_0024.jpg" }
        ]
      }
    ]
  }
  ```

- **`plan/`** — salida de la etapa 4 (`src/lib/plan/agent.ts`), un objeto único por corrida (borrado y re-escrito por completo al re-planear):
  - **`verdicts.json`** — un `Verdict` por clip del job: `{ clip, verdict, curso, razon, confianza, heuristicas }`, donde `verdict` es `"leccion" | "broll" | "descartar" | "otro_curso"`, `confianza` es un número entre 0 y 1, y `heuristicas` es la lista de IDs (kebab-case) de secciones de `config/domain-heuristics.md` que influyeron en ese veredicto.
  - **`structure.json`** — `{ courseTitle, modules, apartados }`: `modules` es la estructura propuesta del curso principal (módulos → lecciones → segmentos, cada segmento con `clip`, `startSeconds`, `endSeconds` y `topic`); cada lección trae además `kind: "demo" | "normal"` (el agente lo emite; si falta, por ejemplo un `structure.json` viejo, se asume `"normal"`) — ver [Etapa 5](#etapa-5-preparación-de-corte-5a5b5c) para qué significa; `apartados` son los veredictos con `verdict: "descartar"` u `"otro_curso"` (todo lo que quedó fuera del curso principal).
  - **`audit.json`** — registro de auditoría central de la corrida: `generatedAt`, `model`, `usage` (tokens de entrada/salida/cache), `framesCalls` (cada llamada a `extraer_frames`: clip, parámetros pedidos, frames agregados) y `clips` (un resumen por clip cruzando `verdict`, `confianza`, `lowConfidence` (`confianza < 0.6`), `heuristicas` citadas y `pidioFramesExtra`).
  - **`decisiones.md`** — documento en Markdown, en español, con las decisiones del agente para revisión humana; si hubo clips con `confianza < 0.6`, la primera sección se titula exactamente `⚠️ Baja confianza` y los lista antes que cualquier otra cosa.

## Etapa 4: agente de plan autónomo

La etapa 4 (`src/lib/plan-stage.ts` → `src/lib/plan/agent.ts`) es un **agente autónomo** que decide, sin aprobación humana en el camino, qué clips se usan, cuáles se descartan y cómo se organiza el material en un curso. La filosofía es explícita: **el humano audita el resultado después** (leyendo `plan/decisiones.md` y la vista de auditoría solo-lectura de `/jobs/[jobId]`), no aprueba paso a paso mientras el agente trabaja. No hay ninguna tool de "pedir confirmación humana"; la única salida posible del agente es su entrega final.

### Modelo y configuración del agente

El agente corre con el SDK oficial de Anthropic (`@anthropic-ai/sdk`, `client.beta.messages.toolRunner`) sobre:

- **Modelo**: `claude-opus-4-8` (constante `MODEL` en `src/lib/plan/agent.ts`).
- **Thinking**: `{ type: "adaptive" }`.
- **Effort**: `output_config: { effort: "high" }`.
- **Tools**: dos tools en formato "strict" de Anthropic (`additionalProperties: false`, `required` completo — ver `src/lib/plan/schemas.ts`):
  - `extraer_frames` — le permite al agente pedir frames adicionales de un clip puntual cuando su confianza es baja.
  - `entregar_resultado` — la única forma en que el agente entrega su trabajo final (veredictos, estructura y `decisiones.md`); el loop del tool-runner termina cuando se llama.
- El loop corre con `stream: true` y `max_iterations: 15`.

### Presupuesto de frames bajo demanda

El agente parte de un set inicial de frames (ver abajo) y puede pedir más vía `extraer_frames` cuando su confianza en un clip es menor a 0.6 y sospecha que le faltan datos (constantes en `src/lib/plan/agent.ts`):

| Límite | Valor | Constante |
|---|---|---|
| Frames por llamada a `extraer_frames` | 12 | `MAX_FRAMES_PER_CALL` |
| Llamadas a `extraer_frames` por corrida | 10 | `MAX_FRAMES_CALLS` |
| Frames extra totales por corrida | 40 | `MAX_TOTAL_EXTRA_FRAMES` |
| Imágenes en el primer turno (set inicial) | 80 | `MAX_INITIAL_IMAGES` |

Cada llamada a la tool estima cuántos frames devolvería (`estimateFrameCount`) antes de ejecutar `ffmpeg`, para poder rechazarla sin gastar trabajo si excede el límite por llamada o el presupuesto total restante; en ese caso la tool responde con un mensaje de error de texto (no una excepción) para que el agente decida con lo que ya tiene. Cada llamada aceptada queda registrada en `framesCalls` de `audit.json`.

El set inicial de frames (primer turno, antes de cualquier llamada a la tool) se arma con `pickInitialFrames`: clips narrados aportan 1 frame (el segundo de su lista si existe, si no el primero disponible); clips sin narración (B-roll) aportan hasta 4, hasta llegar al tope global de `MAX_INITIAL_IMAGES` (80) imágenes en el primer turno.

### Prompt caching

El primer user turn (`buildInitialUserContent`) concatena, en este orden: heurísticas del dominio (`config/domain-heuristics.md`), la transcripción completa (`transcripts/master.txt`), los frames iniciales de cada clip, y un último bloque de texto con instrucciones que cierra con `cache_control: { type: "ephemeral" }`. Ese breakpoint al final del bloque estable permite que el prompt cache de Anthropic cubra todo lo anterior (heurísticas + master.txt + frames iniciales) y se reutilice entre las iteraciones del loop del tool-runner a costo reducido en vez de re-enviar/re-cobrar ese contexto en cada turno. El `PLAN_AGENT_SYSTEM_PROMPT` (`src/lib/plan/prompt.ts`) es además completamente estable entre corridas (sin timestamps ni datos variables del job) para no invalidar el cache del `system`.

El uso acumulado de tokens de todas las iteraciones (`input_tokens`, `output_tokens`, `cache_read_input_tokens`) se guarda en `usage` dentro de `audit.json`.

### `config/domain-heuristics.md` — pistas editables sin tocar código

El motor del agente es genérico: no conoce de antemano el dominio del curso. `config/domain-heuristics.md` es el único lugar donde vive el conocimiento específico del dominio actual (hoy, cursos de ganadería de AgroMax), y el agente las trata siempre como **pistas**, nunca como reglas absolutas que deban obedecerse contra la evidencia real del material (ver `PLAN_AGENT_SYSTEM_PROMPT`).

El archivo es Markdown con secciones `## id-en-kebab-case`; cada ID es citable: cuando una pista de una sección influye en un veredicto, el agente cita ese ID exacto en el campo `heuristicas` de `verdicts.json` (y opcionalmente en `decisiones.md`), lo cual queda cruzado en `audit.json` para auditoría.

**Para agregar una heurística nueva no se toca ningún archivo `.ts`**: basta con editar `config/domain-heuristics.md` y agregar una sección nueva con un ID estable, por ejemplo:

```markdown
## mi-nueva-heuristica

- Descripción de la pista en español, tan específica como haga falta.
```

Si el archivo no existe al correr el agente, `readDomainHeuristics` no falla: registra una advertencia por consola y el agente corre solo con el motor genérico (sin heurísticas de dominio).

### Re-correr sin re-transcribir

Igual que las etapas 2/3.5, la etapa 4 se puede volver a correr sola sobre un job ya muestreado, sin repetir probe/transcripción/muestreo de frames:

```bash
curl -X POST http://localhost:3000/api/jobs/<jobId>/plan
```

`src/app/api/jobs/[jobId]/plan/route.ts` valida que el job exista (404 si no), que su `status` sea uno desde el que tiene sentido planear (`"sampled"`, `"planning"` o `"planned"`; 400 si todavía no fue muestreado) y que no haya ya un pipeline corriendo en memoria para ese job (409 si lo hay), y dispara `runPlanOnly` (`src/lib/pipeline.ts`) en background — nunca vuelve a llamar `runProbeStage`, `runTranscribeStage` ni `runFramesStage`. En la UI, el botón **"Generar estructura (agente)"** (job sin `plan/` aún) o **"Re-generar"** (job ya planeado) de `/jobs/[jobId]` llama a este mismo endpoint.

### Filosofía: el humano audita, no aprueba en el camino

No existe ningún paso de aprobación humana intermedia en la etapa 4: el agente recibe todo el contexto de una corrida (heurísticas, transcripción, frames), decide con su propio criterio (pidiendo más frames si lo necesita, dentro del presupuesto) y entrega un resultado final con `entregar_resultado` que se escribe directamente a disco. El rol del humano es **posterior**: revisar `plan/decisiones.md` y la vista de auditoría solo-lectura de `/jobs/[jobId]` (estructura, veredictos con confianza/razón/heurísticas citadas, frames usados, y los casos donde `pidioFramesExtra` cambió el veredicto), con los clips de baja confianza (`confianza < 0.6`) mostrados primero. Si el resultado no convence, la vía de corrección es editar `config/domain-heuristics.md` (o, en última instancia, volver a correr) — no hay un flujo de edición manual del plan en este repo.

## Etapa 5: preparación de corte (5A/5B/5C)

A diferencia de la etapa 4, la etapa 5 **no tiene ningún agente**: son tres pasos deterministas (`src/lib/silence-stage.ts`, `src/lib/proxy-stage.ts`, `src/lib/cuts-stage.ts`), orquestados en secuencia por `runPrepStages` (`src/lib/pipeline.ts`), que corren sobre los clips `leccion` de `plan/structure.json` (los únicos que se van a editar — `broll`/`descartar`/`otro_curso` no se tocan). Constantes centralizadas en `src/lib/constants.ts`.

### 5A — Detección de silencio (`silence-stage.ts` → `probe/silence.json`)

Por cada clip `leccion`, corre:

```bash
ffmpeg -v error -i <src> -af silencedetect=noise=-30dB:d=0.5 -f null -
```

(`SILENCE_NOISE_DB = -30`, `SILENCE_MIN_D = 0.5`) y parsea del `stderr` los pares `silence_start`/`silence_end` que imprime el filtro. Si el clip termina en silencio, `ffmpeg` no cierra el último tramo (no imprime su `silence_end`): se cierra a mano con la duración real del clip (`probe/media.json`).

- **Lecciones `kind: "demo"`**: se miden los silencios igual (informativo, para poder inspeccionarlos en la UI) pero `skipped: true`, `projectedSeconds = rawSeconds` y `shrinkRatio = 1` — **por qué**: en una demo (instructor trabajando con las manos — laparoscopía, inseminación, descolado, inyecciones) el silencio **ES el contenido**, no aire muerto; recortarlo cortaría la propia técnica que se está mostrando.
- **Lecciones `kind: "normal"`**: se suma la parte *recortable* de cada silencio — `duration - 2 × CUT_PADDING_SECONDS` (0 si el silencio es más corto que el padding de ambos lados) — para obtener `totalSilentSeconds`, y se proyecta `projectedSeconds = rawSeconds - totalSilentSeconds`. `shrinkRatio = projectedSeconds / rawSeconds` sale siempre de lo medido, nunca de un porcentaje fijo asumido.

Idempotente: sobrescribe `probe/silence.json` completo en cada corrida. Nunca toca `source/`.

### 5B — Proxies de edición (`proxy-stage.ts` → `assets/proxies/<clip>.mp4`)

Por cada clip `leccion` que no tenga ya un proxy actualizado, corre:

```bash
ffmpeg -y -i <src> -vf scale=1920:1080 -r 30 \
  -c:v libx264 -crf 18 -preset medium \
  -c:a aac -b:a 192k <clip>.mp4.tmp
```

(`PROXY_WIDTH = 1920`, `PROXY_HEIGHT = 1080`, `PROXY_FPS = 30`) y solo al terminar con éxito renombra `<clip>.mp4.tmp` → `<clip>.mp4` — así un proceso interrumpido a mitad de camino nunca deja un proxy a medio escribir que se confunda con uno completo. Clips sin pista de audio (por ejemplo `video_sin_audio.MOV` del job de prueba) no rompen el comando: con `-c:a aac` pero sin stream de audio de entrada, `ffmpeg` simplemente no produce audio de salida, sin fallar.

**Re-correrlo es barato**: si `assets/proxies/<clip>.mp4` ya existe y es más nuevo (`mtime`) que `source/<clip>`, se salta el transcode entero. Corre en un **pool paralelo** (`PROXY_CONCURRENCY`, default `Math.max(1, Math.min(4, os.cpus().length - 2))` — el transcode con `libx264` es CPU-bound, así que se dejan al menos 2 núcleos libres para el resto del sistema, con tope de 4 para no saturar máquinas grandes). El progreso por clip (`pending`/`running`/`done`/`error`) se persiste en `progress/prep-progress.json` en cada transición; un error en un clip no aborta el resto.

### 5C — Cortes deterministas (`cuts-stage.ts` → `plan/cuts/<lessonId>.json`)

Esta es la pieza más "inspeccionable" del pipeline: **no hay heurísticas ocultas ni agentes de por medio**. Por cada segmento (clip + rango) de cada lección:

- **`kind: "demo"`**: no se toca nada — `cuts: []`, `keep` es el segmento completo. Mismo motivo que en 5A: el silencio es el contenido.
- **`kind: "normal"`**: se toma la transcripción de Whisper del clip (`transcripts/<base>.json`) y se calculan los **huecos** (tramos sin habla) dentro del rango del segmento — incluyendo el hueco inicial (`rangeStart` → primer segmento hablado) y el final (último segmento hablado → `rangeEnd`), si corresponden. Un hueco se convierte en corte si `gapSeconds > GAP_MIN_SECONDS` (0.6s); si no, se deja intacto (no vale la pena recortar aire tan breve).

**Reglas de corte y sus porqués**:

| Regla | Constante | Por qué |
|---|---|---|
| Aire de seguridad a cada lado del corte | `CUT_PADDING_SECONDS = 0.18` | Nunca comerse el borde de una palabra hablada: el corte real empieza `gap.start + 0.18` y termina `gap.end - 0.18`, dejando siempre colchón de silencio real antes y después. |
| Redondeo a frames: `ceil` en el inicio, `floor` en el fin | — | El hueco/padding están en segundos, pero el corte final es en frames enteros. `ceil` en el inicio empuja el corte hacia ADELANTE (más tarde) y `floor` en el fin lo empuja hacia ATRÁS (más temprano) — en ambos casos el redondeo **agranda** el aire alrededor del corte, jamás lo achica. El precio es conservar algún frame de silencio de más, un costo aceptable frente al riesgo de cortar audio real. |
| Clamp al rango del segmento de estructura | — | Un corte nunca puede salirse del segmento al que pertenece; clampear solo puede achicar el corte, nunca agrandarlo, así que la propiedad de "nunca come habla" se preserva. |
| Cortes mínimos | `MIN_CUT_FRAMES = 3` | Tras padding + redondeo + clamp, un corte de menos de 3 frames no vale la pena — se descarta. |
| Huecos mínimos considerados | `GAP_MIN_SECONDS = 0.6` | Huecos más cortos no valen la complejidad de recortarlos. |
| **Nunca se corta a media palabra** | — | Los cortes SOLO existen dentro de huecos entre segmentos de Whisper (nunca dentro de un rango `[segment.start, segment.end]` de habla detectada), con padding de 0.18s de colchón a cada lado. Es geométricamente imposible que un corte se solape con un segmento hablado. |

`confirmedBySilence` marca si el corte final se solapa con algún intervalo de `probe/silence.json` de ese mismo clip — una doble validación (hueco de Whisper + silencio medido con `ffmpeg`) puramente informativa para la UI, no cambia el resultado del corte.

**Convención de frames**: un `FrameRange { startFrame, endFrame }` es un intervalo semiabierto `[startFrame, endFrame)`. Esto hace que `cuts` + `keep` particionen el rango del segmento sin huecos ni traslapes de forma trivial (el `endFrame` de un tramo es el `startFrame` del siguiente). `keep` es siempre el complemento exacto de `cuts` dentro del segmento. `fps = PROXY_FPS` (30) para todos los cálculos de frames.

Idempotente: sobrescribe cada `plan/cuts/<lessonId>.json` en cada corrida. Un clip `normal` sin transcript disponible (caso borde, no debería pasar) se conserva completo sin recortes, con un `console.warn`.

**Ejemplo de `plan/cuts/<lessonId>.json`** (recortado):

```json
{
  "lessonId": "lesson-1",
  "lessonTitle": "Lección de prueba (normal)",
  "fps": 30,
  "generatedAt": "2026-07-21T20:27:01.221Z",
  "clips": [
    {
      "clip": "rumen-final.mp4",
      "kind": "normal",
      "segment": { "startSeconds": 0, "endSeconds": 30, "startFrame": 0, "endFrame": 900 },
      "cuts": [
        {
          "startFrame": 183, "endFrame": 209,
          "startSeconds": 6.1, "endSeconds": 6.97,
          "gapSeconds": 1.24, "confirmedBySilence": false
        }
      ],
      "keep": [
        { "startFrame": 0, "endFrame": 183 },
        { "startFrame": 209, "endFrame": 900 }
      ],
      "stats": { "cutFrames": 26, "keepFrames": 874, "rawSeconds": 30, "projectedSeconds": 29.13 }
    }
  ]
}
```

**Ejemplo de `probe/silence.json`** (recortado):

```json
{
  "generatedAt": "2026-07-21T20:27:01.219Z",
  "clips": [
    {
      "filename": "rumen-final.mp4",
      "kind": "normal",
      "skipped": false,
      "silences": [],
      "count": 0,
      "totalSilentSeconds": 0,
      "rawSeconds": 30,
      "projectedSeconds": 30,
      "shrinkRatio": 1
    }
  ]
}
```

### Re-correr la preparación sin re-planear (`POST /api/jobs/<id>/prep`)

Igual que las etapas 3.5 y 4, la preparación se puede volver a correr sola sobre un job ya planeado, sin repetir probe/transcripción/muestreo/plan (por ejemplo tras corregir a mano un `kind` mal marcado en `structure.json`):

```bash
curl -X POST http://localhost:3000/api/jobs/<jobId>/prep
```

`src/app/api/jobs/[jobId]/prep/route.ts` valida que el job exista (404 si no), que su `status` sea uno desde el que tiene sentido preparar (`"planned"`, `"preparing"` o `"prepared"`; 400 si todavía no fue planeado) y que no haya ya un pipeline corriendo en memoria para ese job (409 si lo hay), y dispara `runPrepOnly` (`src/lib/pipeline.ts`) en background — nunca vuelve a llamar `runProbeStage`, `runTranscribeStage`, `runFramesStage` ni `runPlanStage`. También acepta jobs en `status: "error"` si ya tienen `plan/structure.json` (el prerequisito real de la preparación), para reintentar solo 5A/5B/5C tras un fallo puntual (por ejemplo de `ffmpeg`) sin re-planear todo el curso. Es re-corrible barato: 5A y 5C sobrescriben sus salidas por completo, y 5B (la etapa más cara en CPU) salta los proxies que ya estén al día. En la UI, el botón **"Preparar corte (silencio + proxies + cortes)"** (job sin `plan/cuts/` aún) o **"Re-preparar corte"** (job ya preparado) de `/jobs/[jobId]` llama a este mismo endpoint.

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

Este endpoint valida que el job exista (404 si no) y que no haya ya un pipeline corriendo en memoria para ese mismo job (409 si lo hay), y dispara `runPipeline` de nuevo en background. Es idempotente: sobreescribe `probe/media.json`, `transcripts/`, `progress/progress.json` y (al final del pipeline completo) `frames/` desde cero. En la UI, el botón **"Re-transcribir"** de `/jobs/[jobId]` llama a este mismo endpoint.

## Re-muestrear frames sin re-transcribir

Si la extracción de frames no fue satisfactoria, o simplemente se quiere regenerar la galería tras un cambio manual, se puede volver a correr **solo** la etapa 3.5 sobre un job ya transcrito, sin re-probar ni re-transcribir (lo que sería mucho más lento):

```bash
curl -X POST http://localhost:3000/api/jobs/<jobId>/frames
```

Este endpoint (`src/app/api/jobs/[jobId]/frames/route.ts`) valida que el job exista (404 si no), que su `status` sea uno desde el que tiene sentido muestrear frames (`"transcribed"`, `"sampling"` o `"sampled"`; 400 con mensaje explicativo si todavía no fue transcrito) y que no haya ya un pipeline corriendo en memoria para ese job (409 si lo hay). Dispara `runFramesOnly` en background (`src/lib/pipeline.ts`), que solo corre `runFramesStage` — nunca vuelve a llamar a `runProbeStage` ni a `runTranscribeStage`. Es idempotente: borra y recrea `frames/` por completo en cada corrida (nunca toca `source/`, `probe/` ni `transcripts/`). En la UI, el botón **"Re-muestrear frames"** de `/jobs/[jobId]` llama a este mismo endpoint.

Los JPGs generados se sirven individualmente vía:

```
GET /api/jobs/<jobId>/frames/<clip sin extensión>/frame_SSSS.jpg
```

(`src/app/api/jobs/[jobId]/frames/[...path]/route.ts`), que resuelve la ruta pedida contra `frames/<id>/` y responde 404 si el resultado se sale de ese directorio (anti path-traversal) o si la extensión no es `.jpg`. Devuelve el archivo como `image/jpeg` con `cache-control: no-store`.

## Estructura del código (`src/`)

- `src/lib/types.ts` — tipos compartidos de todo el pipeline (`JobJson`, `JobStatus`, `MediaInfo`, `ProgressJson`, `FrameEntry`, `ManifestClip`, `FramesManifest`, etc.), usados por backend y UI.
- `src/lib/jobs.ts` — persistencia en filesystem de todo el job: `job.json`, `probe/media.json`, `progress/progress.json`, `frames/manifest.json`, `plan/{verdicts,structure,audit}.json`, `plan/decisiones.md`, `probe/silence.json`, `plan/cuts/<lessonId>.json` y `progress/prep-progress.json`, y las rutas de cada subdirectorio (`source/`, `probe/`, `transcripts/`, `progress/`, `frames/`, `plan/`, `plan/cuts/`, `assets/`, `assets/proxies/`). Documenta la invariante de `source/` inmutable.
- `src/lib/constants.ts` — constantes deterministas de las etapas 5A/5B/5C (`PROXY_FPS`, `PROXY_WIDTH`, `PROXY_HEIGHT`, `SILENCE_NOISE_DB`, `SILENCE_MIN_D`, `GAP_MIN_SECONDS`, `CUT_PADDING_SECONDS`, `MIN_CUT_FRAMES`), centralizadas para que queden inspeccionables desde un único lugar.
- `src/lib/zip.ts` — extracción del ZIP subido hacia `jobs/<id>/source/`.
- `src/lib/probe.ts` — análisis inicial de cada video con `ffprobe` durante la ingesta (etapa 1: duración, audio, resolución, detección de problemas para `job.json`).
- `src/lib/probe-stage.ts` — etapa 2: vuelve a correr `ffprobe` sobre `source/` para obtener metadata técnica completa y escribe `probe/media.json`, incluyendo el criterio `needsTranscode`.
- `src/lib/pipeline.ts` — orquestador de las etapas 2, 3, 3.5, 4 y 5A/5B/5C (`runPipeline`), pensado para correr en background (fire-and-forget) tras la ingesta o al re-transcribir. Deduplica corridas concurrentes del mismo job en memoria (`isPipelineRunning`). También expone `runFramesOnly`, que corre únicamente la etapa 3.5 sobre un job ya transcrito (re-muestrear sin re-transcribir), validando que el `status` del job sea `"transcribed"`, `"sampling"` o `"sampled"`; `runPlanOnly`, que corre únicamente la etapa 4 sobre un job ya muestreado (re-planear sin re-transcribir ni re-muestrear), validando que el `status` sea `"sampled"`, `"planning"` o `"planned"`; y `runPrepOnly`, que corre únicamente las etapas 5A/5B/5C sobre un job ya planeado (re-preparar sin re-planear), validando que el `status` sea `"planned"`, `"preparing"` o `"prepared"` (o `"error"` con `plan/structure.json` ya generado).
- `src/lib/transcribe/index.ts` — etapa 3: recorre los archivos en el orden de `probe/media.json`, transcribe cada uno con el motor configurado (con un mini-pool de concurrencia sin dependencias nuevas), detecta narración, escribe `transcripts/` y actualiza `progress/progress.json` por archivo.
- `src/lib/transcribe/types.ts` — contrato TypeScript del motor de transcripción (`TranscribeEngine`, `TranscriptResult`, `TranscriptSegment`, `TranscriptWord`).
- `src/lib/transcribe/engine.ts` — selector de motor según `TRANSCRIBE_ENGINE` (`mlx` o `faster`).
- `src/lib/transcribe/python-engine.ts` — fábrica genérica que invoca cualquier script Python de motor vía `spawn`, parseando su JSON de stdout.
- `src/lib/transcribe/narration.ts` — heurística de detección de narración anti-alucinación (medición de energía de audio + forma del transcript).
- `src/lib/transcribe/writer.ts` — escritura de `<base>.json`/`.tsv`/`.txt` por archivo y de `master.txt` del job completo.
- `src/lib/frames-stage.ts` — etapa 3.5: lee `probe/media.json` y `transcripts/summary.json`, calcula los timestamps a muestrear por clip (narrado vs. B-roll, con fallback de punto medio), extrae un JPG por timestamp con `ffmpeg-static` (mini-pool de concurrencia, mismo patrón que la etapa 3) y escribe `frames/manifest.json`. Borra y recrea `frames/` por completo en cada corrida para que re-muestrear sea idempotente; nunca toca `source/`.
- `src/lib/plan-stage.ts` — etapa 4: valida que `ANTHROPIC_API_KEY` esté configurada (error explícito si no) y delega en `runPlanAgent`.
- `src/lib/plan/agent.ts` — corre el agente autónomo de la etapa 4 con el SDK de Anthropic (`toolRunner` beta, modelo `claude-opus-4-8`, thinking adaptive, effort high): arma el primer turno (heurísticas + `master.txt` + frames iniciales, con breakpoint de prompt cache), expone las tools `extraer_frames` y `entregar_resultado`, gestiona el presupuesto de frames extra bajo demanda, y al recibir `entregar_resultado` escribe `plan/{verdicts,structure,audit}.json` y `plan/decisiones.md`.
- `src/lib/plan/schemas.ts` — JSON Schemas en formato strict de Anthropic (`additionalProperties: false`, `required` completo) de las tools `extraer_frames` y `entregar_resultado` del agente de plan.
- `src/lib/plan/prompt.ts` — system prompt (español, estable entre corridas) del agente autónomo de la etapa 4: motor genérico de dominio, trato de las heurísticas como pistas no reglas, regla de confianza/frames extra, regla de `kind` demo/normal y contrato de `entregar_resultado`.
- `config/domain-heuristics.md` — pistas específicas del dominio actual (cursos de AgroMax), editables sin tocar código; secciones `## id-kebab-case` citables por el agente en `verdicts.json`/`audit.json`.
- `src/lib/silence-stage.ts` — etapa 5A: descubre los clips `leccion` de `plan/structure.json`, corre `ffmpeg silencedetect` sobre cada uno (secuencial) y escribe `probe/silence.json`, con `skipped`/`shrinkRatio` distintos según `kind` demo/normal (ver [Etapa 5](#etapa-5-preparación-de-corte-5a5b5c)).
- `src/lib/proxy-stage.ts` — etapa 5B: transcodifica en paralelo (mini-pool, `PROXY_CONCURRENCY`) los clips `leccion` a proxies de edición 1080p30 h264/aac en `assets/proxies/`, saltando los que ya estén al día; persiste `progress/prep-progress.json` por clip.
- `src/lib/cuts-stage.ts` — etapa 5C: calcula, por cada segmento de cada lección, los cortes deterministas a partir de los huecos entre segmentos de Whisper (con padding, redondeo conservador y clamp al segmento) y escribe `plan/cuts/<lessonId>.json`. La pieza más inspeccionable del pipeline — ver comentarios extensos en el archivo.
- `scripts/setup-python.sh` — crea `.venv-whisper/` e instala `mlx-whisper`.
- `scripts/transcribe_mlx.py` — script del motor `mlx-whisper` (macOS/Apple Silicon).
- `scripts/transcribe_faster.py` — script del motor `faster-whisper` (producción Windows/NVIDIA).
- `src/app/page.tsx` — pantalla única de subida: sube el ZIP (sin más input manual) y redirige a `/jobs/<id>`.
- `src/app/jobs/[jobId]/page.tsx` — vista de job: pollea el estado, muestra progreso por etapa y por archivo, el resumen final con `master.txt`, los botones de re-transcribir/re-muestrear frames/re-generar estructura/re-preparar corte, la galería de miniaturas por clip a partir de `frames/manifest.json`, y la sección de resultados de preparación (silencio/shrink por clip, cortes por lección) a partir de `silence`/`cuts`.
- `src/app/api/ingest/route.ts` — recibe el ZIP, crea el job, corre la ingesta (etapa 1) y dispara `runPipeline` (etapas 2 en adelante) en background.
- `src/app/api/jobs/[jobId]/route.ts` — expone `{ job, media, progress, summary, manifest, structure, audit, verdicts, decisiones, silence, cuts, prepProgress }` de un job para que la UI pollee un único endpoint.
- `src/app/api/jobs/[jobId]/transcribe/route.ts` — re-corre el pipeline completo (probe + transcripción + muestreo de frames) sobre un job existente, sin re-ingerir.
- `src/app/api/jobs/[jobId]/frames/route.ts` — re-corre (o corre por primera vez) solo la etapa de muestreo de frames de un job ya transcrito, sin volver a probar ni re-transcribir.
- `src/app/api/jobs/[jobId]/plan/route.ts` — re-corre (o corre por primera vez) solo la etapa de plan (agente autónomo) de un job ya muestreado, sin volver a probar, transcribir ni re-muestrear frames.
- `src/app/api/jobs/[jobId]/prep/route.ts` — re-corre (o corre por primera vez) solo las etapas de preparación (5A/5B/5C) de un job ya planeado, sin volver a probar, transcribir, re-muestrear frames ni re-planear.
- `src/app/api/jobs/[jobId]/frames/[...path]/route.ts` — sirve un JPG individual de `frames/<id>/` como `image/jpeg`, con protección anti path-traversal.
- `src/app/api/jobs/[jobId]/master/route.ts` — sirve `transcripts/master.txt` como texto plano (404 si no existe todavía).
