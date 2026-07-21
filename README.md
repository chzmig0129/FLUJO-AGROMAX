# AgroMax — Ingesta (Etapa 1)

AgroMax es un pipeline que convierte video crudo en un curso online. Este repositorio implementa **la etapa 1: Ingesta**, la aplicación que recibe un ZIP de videos crudos, los analiza y produce un job estructurado listo para las siguientes etapas del pipeline (que aún no existen en este repo — vendrán después).

Es una app Next.js full-stack, sin base de datos y sin autenticación: el estado de cada job vive en el filesystem, en `jobs/<id>/`.

## Requisitos

- Node.js 20 o superior.

No hace falta instalar `ffmpeg` ni `ffprobe` a mano: vienen empaquetados como dependencias de npm (`ffmpeg-static` y `ffprobe-static`) y se instalan junto con el resto del proyecto.

## Instalación

```bash
npm install
```

Con eso alcanza. No hay pasos manuales adicionales (sin variables de entorno, sin servicios externos, sin configuración de binarios).

## Correr la app

```bash
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000) en el navegador.

## Flujo de uso

La ingesta de un job se hace en 3 pantallas:

1. **Subir** (`/`): el usuario sube un archivo ZIP con los videos crudos y le da un nombre al job. Al confirmar, se crea `jobs/<id>/` y arranca el análisis de cada video con `ffprobe`.
2. **Ordenar y titular** (`/jobs/[jobId]`): una vez terminado el análisis, se listan los videos detectados. El usuario define el orden final y el título de cada uno. Los videos con problemas (sin audio, duración inválida, archivo no reconocible como video) se marcan con una bandera visible para que el usuario decida qué hacer antes de confirmar.
3. **Resumen final** (`/jobs/[jobId]/done`): tras confirmar el orden y los títulos, se muestra un resumen del job ya ingerido (listo para que una etapa futura del pipeline lo tome como entrada).

## Estructura de `jobs/<id>/`

Cada job de ingesta vive en su propia carpeta dentro de `jobs/`, identificada por un UUID:

```
jobs/
  <id>/
    source/       # videos extraídos del ZIP subido (el ZIP original NO se guarda aquí)
    job.json       # estado del job y metadata de cada video
    order.json      # orden y títulos de cada video (se crea en la ingesta, se sobrescribe al confirmar)
```

- **`source/` es inmutable**: el ZIP subido se guarda temporalmente como `jobs/<id>/upload.zip`, se extrae a `source/` y luego se borra — nunca queda dentro de `source/`. Una vez extraído, los archivos dentro de `source/` nunca se modifican ni se reordenan. El orden y los títulos elegidos por el usuario viven aparte, en `order.json`, como referencias a los archivos de `source/`.

- **`job.json`** — estado del job y metadata de cada video analizado con `ffprobe`. Ejemplo:

  ```json
  {
    "id": "3fa1c2b0-1234-4abc-9def-abcdef123456",
    "name": "Curso de riego por goteo",
    "status": "ingested",
    "stage": "ingest",
    "createdAt": "2026-07-20T10:00:00.000Z",
    "updatedAt": "2026-07-20T10:05:00.000Z",
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
    ]
  }
  ```

  El tipo `JobStatus` define `"processing"`, `"ingested"` y `"error"`, pero hoy el único valor que el código realmente escribe es `"ingested"`: `job.json` solo se crea después de que `ffprobe` ya terminó de analizar los videos, y si algo falla durante la ingesta se borra el directorio completo del job (`jobs/<id>/`) en vez de marcarlo con `status: "error"`. `"processing"` y `"error"` quedan reservados para una implementación futura. `issues` puede contener `"not_a_video"`, `"zero_duration"` y/o `"no_audio"`.

- **`order.json`** — orden y título de cada video. Se crea durante la ingesta inicial (`POST /api/ingest`) con orden alfabético por nombre de archivo y título por defecto (el nombre de archivo sin extensión), y se sobrescribe con el orden y los títulos definitivos al confirmar en la pantalla de "ordenar y titular". Ejemplo:

  ```json
  {
    "order": [
      { "file": "clip1.mp4", "title": "Introducción al riego por goteo" },
      { "file": "clip2.mov", "title": "Instalación de los emisores" }
    ]
  }
  ```

## Estructura del código (`src/`)

- `src/lib/types.ts` — tipos compartidos del contrato de datos de la ingesta (`JobJson`, `OrderJson`, `VideoFileMeta`, etc.), usados tanto por el backend como por la UI.
- `src/lib/jobs.ts` — creación, lectura y actualización de jobs en el filesystem (`jobs/<id>/job.json`, `order.json`).
- `src/lib/zip.ts` — extracción del ZIP subido hacia `jobs/<id>/source/`.
- `src/lib/probe.ts` — análisis de cada video extraído con `ffprobe` (duración, audio, resolución, detección de problemas).
- `src/app/page.tsx` — pantalla 1: subir ZIP y nombrar el job.
- `src/app/jobs/[jobId]/page.tsx` — pantalla 2: ordenar y titular los videos, con banderas de problemas.
- `src/app/jobs/[jobId]/done/page.tsx` — pantalla 3: resumen final del job ya ingerido.
- `src/app/api/ingest/route.ts` — endpoint que recibe el ZIP subido, crea el job y dispara el análisis con ffprobe.
- `src/app/api/jobs/[jobId]/route.ts` — endpoint que expone el estado actual de un job (`job.json`).
- `src/app/api/jobs/[jobId]/confirm/route.ts` — endpoint que recibe el orden/títulos definidos por el usuario y escribe `order.json`.

## Sobre las próximas etapas

Este repositorio cubre únicamente la etapa 1 (Ingesta). Las etapas siguientes del pipeline AgroMax (edición, generación del curso, publicación, etc.) todavía no existen y no forman parte de este README.
