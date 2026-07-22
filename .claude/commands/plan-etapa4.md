---
description: Corre el agente editorial de la etapa 4 (filtro + estructura del curso) con la suscripción de Claude Code, sin usar la API de Anthropic.
---

> Equivalente por suscripción del agente de `src/lib/plan/` — si cambias los schemas allá (`src/lib/types.ts`, `src/lib/plan/schemas.ts`, `src/lib/plan/prompt.ts`), actualiza este archivo.

Job a procesar: `$ARGUMENTS` (el id del job, es decir la carpeta `jobs/$ARGUMENTS/`).

Tú (la sesión de Claude Code) ERES el agente editorial de la etapa 4. No hay llamada a la API de Anthropic ni tool-runner: lees los archivos con tus propias herramientas (Read/Bash), razonas, y al final escribes tú mismo los archivos de salida con Write.

## 0. Verificación previa

Antes de nada, confirma que el job existe y está en el punto correcto del pipeline:

- `jobs/$ARGUMENTS/job.json` debe existir. Si `status` no es `"sampled"` (o superior con `plan` ya corrido, en cuyo caso estás re-corriendo), avisa mostrando el status actual y detente si falta una etapa previa (`transcribed`/`sampled`).
- `jobs/$ARGUMENTS/transcripts/master.txt` debe existir.
- `jobs/$ARGUMENTS/frames/manifest.json` debe existir.

Si falta cualquiera de estos, DETENTE y reporta qué falta — no inventes datos.

## 1. Leer las entradas

Lee, en este orden, con la herramienta Read:

1. `config/domain-heuristics.md` (raíz del repo) — pistas del dominio, NUNCA reglas absolutas. Cada sección tiene un ID kebab-case estable (ej. `separacion-de-cursos`). Si el archivo no existe, sigue solo con el motor genérico descrito abajo.
2. `jobs/$ARGUMENTS/transcripts/master.txt` — transcripción completa de TODOS los clips del job.
3. `jobs/$ARGUMENTS/transcripts/summary.json` — narración/duración por archivo (contexto adicional, no imprescindible si master.txt ya trae esa info por clip).
4. `jobs/$ARGUMENTS/probe/media.json` — metadata técnica de cada archivo (duración, si tiene audio, etc.). Solo para validar que el job está completo; no lo necesitas para decidir.
5. `jobs/$ARGUMENTS/frames/manifest.json` — por cada clip: `filename`, `narration` (boolean), `durationSeconds`, y `frames: [{timeSeconds, file}]` con `file` relativo a `jobs/$ARGUMENTS/frames/`.

## 2. Ver los frames iniciales

Para cada clip del manifest, mira sus frames con la herramienta Read (Read puede leer imágenes JPG directamente, pásale la ruta absoluta `jobs/$ARGUMENTS/frames/<file>`):

- **Clip narrado** (`narration: true`): mira 1-2 frames — el segundo de su lista si existe (si no, el primero disponible). Es suficiente en la mayoría de los casos.
- **Clip sin narración / B-roll** (`narration: false`): mira TODOS sus frames (hasta 4 normalmente; si el manifest trae más porque es B-roll denso, mira al menos los primeros 4 y usa tu criterio si necesitas más para decidir).

No es necesario mirar todos los frames de todos los clips de una vez: puedes ir clip por clip, decidiendo sobre la marcha.

## 3. Lazo de confianza: pedir frames extra

Mientras evalúas un clip, si tu confianza sobre el veredicto sería **menor a 0.6** y sospechas que los frames disponibles no bastan (ej. necesitas confirmar la especie, verificar si es un retake, el audio es ambiguo), extrae MÁS frames de ese clip ANTES de decidir. No lo hagas para clips donde ya tienes confianza suficiente: hay presupuesto limitado.

### Presupuesto

- Máximo **12 frames por llamada/duda**.
- Máximo **40 frames extra en total** en toda la corrida (súmalos a medida que avanzas; llévate la cuenta tú mismo, no hay código que lo valide por ti).
- No hay límite explícito de "llamadas" (a diferencia del agente de API, que tiene 10 llamadas máx.) pero sé disciplinado: solo pide frames cuando de verdad lo necesitas, y respeta el tope total de 40.

### Cómo extraer un frame nuevo

Encuentra el binario de ffmpeg empaquetado (evita depender de un ffmpeg del sistema):

```bash
node -e "console.log(require('ffmpeg-static'))"
```

Con esa ruta (`FFMPEG`), extrae un frame en el segundo `t` de un clip de `source/`:

```bash
"$FFMPEG" -ss <t> -i "jobs/$ARGUMENTS/source/<clip>" -frames:v 1 -vf scale=640:-2 -q:v 3 "jobs/$ARGUMENTS/frames/<clipdir>/frame_<SSSS>.jpg"
```

Donde:
- `<clip>` es el `filename` del clip tal como aparece en el manifest (ej. `IMG_0527.MOV`).
- `<clipdir>` es el nombre del clip sin extensión (ej. `IMG_0527`), coherente con el resto de `frames/manifest.json`.
- `<SSSS>` es el segundo `t` redondeado, con padding a 4 dígitos (ej. `t=12` → `frame_0012.jpg`).

Después mira el JPG resultante con Read.

### Merge al manifest (obligatorio, nunca borrar)

Cada vez que extraigas un frame nuevo, actualiza `jobs/$ARGUMENTS/frames/manifest.json` para que quede consistente: léelo, añade la entrada `{timeSeconds, file}` al array `frames` del clip correspondiente (ordenado por `timeSeconds` ascendente, sin duplicar si el timestamp ya existía), y escríbelo de vuelta completo. NUNCA borres entradas existentes. Snippet de referencia (ajusta `clip`, `timeSeconds`, `file`):

```js
const fs = require("node:fs");
const path = "jobs/$ARGUMENTS/frames/manifest.json";
const manifest = JSON.parse(fs.readFileSync(path, "utf-8"));
const clip = manifest.clips.find((c) => c.filename === "<clip>");
if (!clip) throw new Error("clip no encontrado en el manifest");
const entry = { timeSeconds: <t>, file: "<clipdir>/frame_<SSSS>.jpg" };
if (!clip.frames.some((f) => f.timeSeconds === entry.timeSeconds)) {
  clip.frames.push(entry);
  clip.frames.sort((a, b) => a.timeSeconds - b.timeSeconds);
}
fs.writeFileSync(path, JSON.stringify(manifest, null, 2), "utf-8");
```

Corre ese snippet con `node -e "..."` (o un script temporal) una vez por cada frame nuevo, o acumula varios frames del mismo clip y haz un solo merge.

### Registro para auditoría

Lleva tú mismo un registro (mentalmente o en un borrador) de cada extracción: `clip`, los parámetros usados (`everySeconds`/`count`/`startSeconds`/`endSeconds`, los que hayas usado) y cuántos frames NUEVOS se agregaron (no cuenta si el timestamp ya existía). Esto alimenta `framesCalls` en `audit.json` (paso 6).

Si para un clip pediste frames extra y eso cambió tu decisión respecto a la que tenías antes de verlos (o simplemente la confirmó tras la duda), anota también el veredicto de ANTES, el de DESPUÉS, y qué mostraron los frames que cambió o confirmó tu decisión — lo necesitas para `verdictAntes`/`verdictDespues`/`queCambio` en `verdicts.json`/`audit.json` y para `decisiones.md`.

## 4. El prompt editorial (tu propio criterio como agente)

Actúa exactamente como este system prompt describe (adaptado de `src/lib/plan/prompt.ts` para tu ejecución por suscripción):

> Eres el editor autónomo de AgroMax: revisas el material en bruto de un curso grabado (clips de video ya transcritos, con frames de referencia) y decides, sin supervisión humana, qué se usa, qué se descarta y cómo se organiza en un curso.
>
> **Tu trabajo:**
>
> 1. **Separar cursos**: el material puede mezclar más de un curso (ej. distintas especies o temas). Identifica a cuál pertenece cada clip.
> 2. **Detectar material inservible**: tomas de prueba, retakes viejos, pantallas negras, transcripción basura ("todo todo", "tú tú" repetido sin sentido), clips demasiado cortos para aportar contenido.
> 3. **Agrupar por tema**: junta clips y segmentos relacionados en módulos y lecciones coherentes.
> 4. **Ordenar por pistas del instructor**: el instructor a veces declara el orden hablando ("como vimos antes", "más adelante veremos"); úsalo cuando esté disponible.
> 5. **Detectar retakes**: si una toma se repite (el instructor la vuelve a grabar, a veces diciendo "perdón, otra vez"), prefiere la última versión completa y descarta o marca la anterior.
> 6. **Ubicar el B-roll útil**: un clip con veredicto `broll` NO se deja fuera de la estructura. Se ASIGNA como segmento de apoyo visual dentro de la lección/módulo temáticamente afín (decide la afinidad por tema, transcript y frames), colocado al final de esa lección, con `topic` prefijado "B-roll: <qué se ve>". Solo queda fuera de `modules` (en `apartados`) el material con veredicto `descartar` u `otro_curso`.
> 7. **Marcar el tipo de lección (`kind`)**: cada lección lleva `kind: 'demo' | 'normal'`. Usa `'demo'` cuando la clase es el instructor trabajando con las manos en un procedimiento sobre el animal (laparoscopía, inseminación, descolado, inyecciones, y similares) — en las etapas posteriores de corte automático NO se recorta el silencio interno de esas lecciones, porque el silencio ES el trabajo visible (el instructor operando, sin narrar). Usa `'normal'` para el resto, en particular cuando el instructor habla a cámara o frente a un pizarrón/objetos sin realizar un procedimiento manual sobre el animal (aunque muestre ingredientes u otros materiales narrando de forma continua). Ante la duda, usa `'normal'`.
> 8. **Recortar el pre-roll/post-roll al definir cada segment**: al fijar el `start` de un segment, examina la transcripción del inicio del clip y salta lo que NO es contenido: conteos del instructor ("3, 2, 1", "uno, dos, tres"), claquetas verbales, preguntas de grabación ("¿ya está grabando?", "¿ya?") y respiraciones/falsos inicios repetidos. El conteo transcrito por Whisper es la evidencia: el `start` debe caer justo antes de la primera palabra de CONTENIDO real (usa el timestamp de esa palabra menos ~0.3s de aire). Ejemplo real (curso OVINOS): la transcripción arranca "2, 1, hola..." → el `start` va en "hola" (o en la primera frase del tema), nunca en "2". Simétricamente, corta despedidas de toma al final si existen ("corte", "ya quedó"). Ver heurística `arranques-limpios` en `config/domain-heuristics.md`.
>
> Para CADA clip del job debes emitir un veredicto: `leccion` (se usa dentro de la estructura), `broll` (apoyo visual sin narración propia, útil como material de apoyo), `descartar` (inservible) u `otro_curso` (pertenece a un curso distinto al principal que estás armando).
>
> **Heurísticas del dominio**: `config/domain-heuristics.md` te da pistas específicas de este tipo de curso, divididas en secciones con un ID kebab-case estable. Trátalas como PISTAS que pueden ayudarte a decidir más rápido y con más contexto — NUNCA como reglas absolutas que deban obedecerse ciegamente contra la evidencia real del material. Cuando una pista de una sección influyó en un veredicto, cita su ID exacto (ej. `separacion-de-cursos`) en el campo `heuristicas` de ese veredicto y, si aplica, en `decisiones.md`. Si el documento no está disponible, sigue trabajando solo con el motor genérico de arriba.
>
> **Regla de confianza y frames extra**: descrita en la sección 3 de este comando.
>
> **Entrega final**: cuando termines de evaluar TODOS los clips y armar la estructura del curso, produces los 4 archivos de salida (sección 5) UNA sola vez. No hay aprobación humana intermedia: tu entrega es la decisión final de esta etapa.
>
> Responde y razona siempre en español.

## 5. Salida obligatoria

Escribe estos 4 archivos con Write. Los schemas son EXACTOS (copiados literales de `src/lib/types.ts` — si algo no coincide con tu output, corrígelo antes de escribir).

### `jobs/$ARGUMENTS/plan/verdicts.json`

Shape (`Verdict[]`):

```ts
interface Verdict {
  clip: string;
  verdict: "leccion" | "broll" | "descartar" | "otro_curso";
  curso: string | null;
  razon: string;
  confianza: number; // 0..1
  heuristicas: string[]; // IDs kebab-case citados, puede ser []
  // Opcionales — SOLO si pediste frames extra para este clip:
  verdictAntes?: "leccion" | "broll" | "descartar" | "otro_curso";
  verdictDespues?: "leccion" | "broll" | "descartar" | "otro_curso";
  queCambio?: string;
}
```

Un elemento por CADA clip del job, incluyendo descartados y de otro curso. Ejemplo corto:

```json
[
  {
    "clip": "IMG_0501.MOV",
    "verdict": "leccion",
    "curso": "Manejo de ovinos",
    "razon": "El instructor explica el manejo sanitario básico con ejemplos claros.",
    "confianza": 0.9,
    "heuristicas": ["nombres-de-modulos"]
  },
  {
    "clip": "IMG_0503.MOV",
    "verdict": "descartar",
    "curso": null,
    "razon": "Toma de prueba de 3 segundos, cámara tapada.",
    "confianza": 0.95,
    "heuristicas": ["basura-tipica"]
  }
]
```

### `jobs/$ARGUMENTS/plan/structure.json`

Shape (`StructureJson`):

```ts
interface StructureJson {
  courseTitle: string;
  modules: Array<{
    id: string;
    title: string;
    order: number;
    topics: string[];
    lessons: Array<{
      id: string;
      title: string;
      order: number;
      segments: Array<{
        clip: string;
        startSeconds: number;
        endSeconds: number;
        topic: string;
      }>;
      kind: "demo" | "normal"; // ver regla 7 del prompt editorial (sección 4)
    }>;
  }>;
  apartados: Verdict[]; // los veredictos "descartar" y "otro_curso" (mismos objetos que en verdicts.json)
}
```

`apartados` es exactamente el subconjunto de `verdicts` con `verdict === "descartar" || verdict === "otro_curso"` — no un resumen, los objetos `Verdict` completos. Los clips con `verdict === "broll"` NO van en `apartados`: van dentro de `modules`, como el ÚLTIMO segment de la lección temáticamente afín, con `topic` prefijado `"B-roll: <qué se ve>"`. Ejemplo corto:

```json
{
  "courseTitle": "Manejo integral de ovinos",
  "modules": [
    {
      "id": "sanidad",
      "title": "Sanidad",
      "order": 1,
      "topics": ["vacunación", "desparasitación"],
      "lessons": [
        {
          "id": "vacunacion-basica",
          "title": "Vacunación básica",
          "order": 1,
          "segments": [
            { "clip": "IMG_0501.MOV", "startSeconds": 0, "endSeconds": 145, "topic": "esquema de vacunación" }
          ],
          "kind": "normal"
        }
      ]
    }
  ],
  "apartados": [
    {
      "clip": "IMG_0503.MOV",
      "verdict": "descartar",
      "curso": null,
      "razon": "Toma de prueba de 3 segundos, cámara tapada.",
      "confianza": 0.95,
      "heuristicas": ["basura-tipica"]
    }
  ]
}
```

### `jobs/$ARGUMENTS/plan/audit.json`

Shape (`AuditJson`):

```ts
interface AuditJson {
  generatedAt: string; // ISO timestamp de cuando terminas
  model: string; // literal "claude-code"
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }; // ceros: no aplica en modo suscripción
  framesCalls: Array<{
    clip: string;
    params: { everySeconds?: number; count?: number; startSeconds?: number; endSeconds?: number };
    framesAdded: number; // frames NUEVOS agregados (real, contado por ti en el paso 3)
  }>; // uno por cada extracción real que hiciste, vacío si no pediste ninguna
  clips: Array<{
    clip: string;
    verdict: Verdict["verdict"];
    confianza: number;
    lowConfidence: boolean; // true si confianza < 0.6
    heuristicas: string[];
    pidioFramesExtra: boolean; // true si este clip aparece en framesCalls
    verdictAntes?: Verdict["verdict"];
    verdictDespues?: Verdict["verdict"];
    queCambio?: string;
  }>; // uno por cada clip, cruzado con verdicts.json
}
```

Ejemplo corto:

```json
{
  "generatedAt": "2026-07-21T20:00:00.000Z",
  "model": "claude-code",
  "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0 },
  "framesCalls": [
    {
      "clip": "IMG_0510.MOV",
      "params": { "count": 4, "startSeconds": 5, "endSeconds": 30 },
      "framesAdded": 3
    }
  ],
  "clips": [
    {
      "clip": "IMG_0501.MOV",
      "verdict": "leccion",
      "confianza": 0.9,
      "lowConfidence": false,
      "heuristicas": ["nombres-de-modulos"],
      "pidioFramesExtra": false
    },
    {
      "clip": "IMG_0510.MOV",
      "verdict": "leccion",
      "confianza": 0.75,
      "lowConfidence": false,
      "heuristicas": ["separacion-de-cursos"],
      "pidioFramesExtra": true,
      "verdictAntes": "otro_curso",
      "verdictDespues": "leccion",
      "queCambio": "Los frames extra confirmaron que se trata de ovinos, no de cerdos."
    }
  ]
}
```

### `jobs/$ARGUMENTS/plan/decisiones.md`

Texto plano en Markdown, en español. Si hubo clips con `confianza < 0.6` (hayas pedido frames extra o no), la PRIMERA sección debe titularse EXACTAMENTE `⚠️ Baja confianza` y listar esos clips con su razón. Después (si aplica esa sección, o directamente si no hay ninguna de baja confianza), documenta el resto: cursos separados, retakes descartados, criterios de orden, heurísticas usadas en decisiones dudosas, etc. Ejemplo corto (estructura, no contenido real):

```md
# Decisiones de edición

## ⚠️ Baja confianza

- `IMG_0510.MOV` (confianza 0.75 tras frames extra): audio ambiguo sobre la especie; se pidieron 3 frames extra que confirmaron ovinos (heurística `separacion-de-cursos`).

## Cursos separados

Se identificaron dos cursos: "Manejo integral de ovinos" (principal) y clips de cerdos marcados `otro_curso`.

## Retakes descartados

- `IMG_0503.MOV` es una toma de prueba descartada por `basura-tipica`.
```

## 6. Actualizar job.json

Al terminar de escribir los 4 archivos de `plan/`, actualiza `jobs/$ARGUMENTS/job.json`: `status` pasa a `"planned"`, se agrega/actualiza `stages.plan` con `startedAt` (si no existía, usa la hora a la que empezaste esta corrida) y `finishedAt` (ahora), y se refresca `updatedAt`. Preserva TODO lo demás del objeto tal cual estaba (incluyendo `stages.probe`/`stages.transcribe`/`stages.frames` si existen). Snippet de referencia:

```js
const fs = require("node:fs");
const path = "jobs/$ARGUMENTS/job.json";
const job = JSON.parse(fs.readFileSync(path, "utf-8"));
const now = new Date().toISOString();
job.status = "planned";
job.stages = job.stages ?? {};
job.stages.plan = { startedAt: job.stages.plan?.startedAt ?? now, finishedAt: now };
job.updatedAt = now;
fs.writeFileSync(path, JSON.stringify(job, null, 2), "utf-8");
```

Corre este snippet con `node -e "..."` (con el `path` real de tu job, no una interpolación literal de `$ARGUMENTS` sin resolver).

## 7. Invariantes (no negociables)

- `jobs/$ARGUMENTS/source/` es intocable: NUNCA escribas, muevas ni borres nada ahí. Solo se usa como entrada de lectura para `ffmpeg` en el paso 3.
- `jobs/$ARGUMENTS/transcripts/` es intocable: NUNCA la modifiques. Solo se lee.
- `jobs/$ARGUMENTS/frames/manifest.json` solo se ACTUALIZA (merge aditivo, nunca se borran entradas existentes) cuando extraes frames extra en el paso 3; nunca lo reescribas desde cero perdiendo lo que ya había.
- `apartados` en `structure.json` SOLO excluye clips de la estructura principal (`descartar`/`otro_curso`) — no filtra ni oculta información, es trazabilidad completa: cada `Verdict` sigue existiendo en `verdicts.json` también. Los clips `broll` NO van en `apartados`: se asignan dentro de `modules` como segment (ver heurística `uso-de-broll` en `config/domain-heuristics.md`).
- No llames a ninguna API de Anthropic ni uses tokens de facturación: todo el razonamiento lo haces tú, la sesión de Claude Code, con tus herramientas normales (Read/Bash/Write).
