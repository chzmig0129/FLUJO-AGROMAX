---
description: Genera los briefs de overlays didácticos (etapa 7) de un job ya con estructura y transcripciones, usando la suscripción de Claude Code, sin usar la API de Anthropic.
---

Job a procesar: `$ARGUMENTS` (el id del job, es decir la carpeta `jobs/$ARGUMENTS/`).

Tú (la sesión de Claude Code) ERES el agente de briefs de overlays de la
etapa 7. No hay llamada a la API de Anthropic ni tool-runner: lees los
archivos con tus propias herramientas (Read), razonas, y al final escribes
tú mismo los archivos de salida con Write.

## 0. Verificación previa

Antes de nada, confirma que el job tiene lo necesario:

- `jobs/$ARGUMENTS/plan/structure.json` debe existir. Si no, DETENTE y
  reporta que falta la etapa de plan (estructura) — no inventes datos.
- `jobs/$ARGUMENTS/transcripts/` debe existir y tener al menos un archivo
  `.json` (transcripciones fuente por clip).

## 1. Leer las entradas

Lee, en este orden, con la herramienta Read:

1. `jobs/$ARGUMENTS/plan/structure.json` — la estructura completa del curso
   (`StructureJson`: módulos → lecciones → segments, cada `segment` con
   `clip`, `startSeconds`, `endSeconds`, `topic`).
2. Para CADA lección de CADA módulo, y para CADA `segment` de esa lección,
   su transcripción fuente en `jobs/$ARGUMENTS/transcripts/<clip>.json`
   (mismo nombre base que `segment.clip`, sin extensión de video). De esa
   transcripción usa SOLO los `segments[]` cuyo `start`/`end` caen dentro
   del rango `[segment.startSeconds, segment.endSeconds)` del segmento de la
   lección — es la porción de narración real de ese tramo, no el clip
   completo.

## 2. REGLA CENTRAL (cítala mentalmente en cada decisión)

> Un overlay debe enseñar lo que la narración NO muestra. Si el overlay solo
> repite en imagen lo que la palabra hablada ya dice de forma clara, ese
> overlay NO debe existir.

Disparadores válidos para proponer un overlay (necesitas al menos uno,
anclado a un hecho VERBATIM de la transcripción):

- **Dato numérico** (ej. "70 a 80 por ciento de las muertes en lactancia
  ocurren en las primeras 72 horas").
- **Regla o procedimiento** (ej. pasos de una técnica, dosis, secuencia).
- **Comparación** (ej. línea materna vs línea paterna, gestante vs engorda).
- **Lista** (ej. tres vacunas, cuatro partes de un equipo).

Si una lección no tiene ningún tramo que dispare un overlay real bajo la
regla central, su presupuesto para esa lección es 0 — **0 es un resultado
válido y esperado**, no un fallo.

**Presupuesto por lección: entre 2 y 4 briefs.** Nunca más de 4 aunque haya
más disparadores (prioriza los más didácticos); nunca fuerces briefs
artificiales solo para llegar a 2 si la lección no tiene material real: en
ese caso el presupuesto de esa lección puede ser menor, incluyendo 0.

## 3. Cita VERBATIM obligatoria

Cada brief DEBE incluir en su campo `fact` una cita **textual, verbatim**,
copiada tal cual del `text` (o de la concatenación de `words`) del segmento
de transcripción que lo origina — sin parafrasear, sin traducir, sin
corregir jerga. Esto es lo que hace verificable mecánicamente el Gate 1
(una etapa posterior compara `fact` contra el transcript fuente): si `fact`
no aparece literal en algún `segments[].text` de la transcripción del clip,
el brief es inválido. No inventes hechos ni los generalices.

## 4. Escribir el `prompt` visual (SIN el style)

El campo `prompt` de cada brief describe SOLO el contenido visual concreto:
qué figuras, qué texto exacto (entre comillas) va en pantalla, cómo se
disponen. **NO incluyas el bloque de estilo** (paleta, fondo blanco, etc.):
eso vive en `config/overlay-style.md` y se concatena aparte en una etapa
posterior (generación de imagen). Sé específico y concreto, igual de
detallado que los ejemplos de
`/Users/chavez/Documents/AGROMAX/EDITOR/overlays/gen_ilustraciones.py`
(diagramas, tarjetas con texto exacto entre comillas, comparaciones lado a
lado, escalas numeradas) pero sin la cola de estilo.

## 5. Salida obligatoria

Para CADA lección de `plan/structure.json` (incluidas las que terminen con
0 briefs), escribe con Write:

`jobs/$ARGUMENTS/plan/overlays/<lessonId>.json`

```ts
interface OverlayBrief {
  key: string;         // slug corto y único dentro de la lección (snake_case)
  fact: string;        // cita VERBATIM del hecho en la transcripción fuente
  at_seconds: number;  // momento, en tiempo FUENTE del clip, donde ocurre el hecho citado
  clip: string;         // nombre del clip fuente (igual que segment.clip en structure.json)
  prompt: string;       // descripción visual concreta, SIN el style (ver sección 4)
  aspect: "wide" | "square";
}

interface OverlaysFile {
  lessonId: string;
  generatedAt: string; // ISO timestamp de cuando terminas esta lección
  briefs: OverlayBrief[]; // puede ser [] — 0 briefs es válido
}
```

Ejemplo corto:

```json
{
  "lessonId": "manejo-de-la-ubre",
  "generatedAt": "2026-07-22T03:00:00.000Z",
  "briefs": [
    {
      "key": "mortalidad_72h",
      "fact": "el 70 a 80 por ciento de las muertes en lactancia ocurren en las primeras 72 horas",
      "at_seconds": 184.2,
      "clip": "IMG_0603.mp4",
      "prompt": "Una gráfica de dona grande mostrando 70 a 80 por ciento en verde. En el centro de la dona el texto grande '70-80%'. Debajo de la gráfica dos renglones de texto: 'de las muertes en lactancia' y 'ocurren en las primeras 72 horas'.",
      "aspect": "square"
    }
  ]
}
```

Crea el directorio `jobs/$ARGUMENTS/plan/overlays/` si no existe.

## 6. Invariantes (no negociables)

- `jobs/$ARGUMENTS/transcripts/` y `jobs/$ARGUMENTS/plan/structure.json` son
  intocables: NUNCA los modifiques. Solo se leen como referencia.
- Un archivo `plan/overlays/<lessonId>.json` por CADA lección de la
  estructura, aunque su `briefs` quede vacío — no omitas lecciones.
- Nunca incluyas el bloque de estilo (`config/overlay-style.md`) dentro de
  `prompt`: eso se concatena en una etapa posterior.
- `fact` siempre verbatim, nunca parafraseado: si no puedes citar el hecho
  tal cual del transcript, no escribas ese brief.
- No llames a ninguna API de Anthropic ni uses tokens de facturación: todo
  el razonamiento lo haces tú, la sesión de Claude Code, con tus
  herramientas normales (Read/Write).
