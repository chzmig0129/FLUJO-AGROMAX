---
description: Audita y corrige la jerga técnica mal escrita en los subtítulos (captions) de un job ya preparado, usando la suscripción de Claude Code, sin usar la API de Anthropic.
---

Job a procesar: `$ARGUMENTS` (el id del job, es decir la carpeta `jobs/$ARGUMENTS/`).

Tú (la sesión de Claude Code) ERES el auditor de subtítulos de la etapa 12. No hay llamada a la API de Anthropic ni tool-runner: lees los archivos con tus propias herramientas (Read), razonas, y al final escribes tú mismo los archivos de salida con Write.

## 0. Verificación previa

Antes de nada, confirma que el job tiene lo necesario:

- `jobs/$ARGUMENTS/plan/captions/` debe existir y tener al menos un archivo `.json`. Si no, DETENTE y reporta que falta la etapa de captions — no inventes datos.
- `jobs/$ARGUMENTS/transcripts/` debe existir (transcripciones fuente contra las que se contrasta cada caption).

## 1. Leer las entradas

Lee, en este orden, con la herramienta Read:

1. `config/glosario.md` (raíz del repo) — glosario semilla del dominio: jerga técnica mal escrita típica y su corrección. Si el archivo no existe, sigue solo con tu propio criterio.
2. `jobs/$ARGUMENTS/plan/glosario.md` — glosario específico de este job, con correcciones aprendidas en corridas anteriores de esta misma auditoría. Puede no existir todavía (primera corrida): en ese caso lo crearás en el paso 4.
3. Cada archivo `jobs/$ARGUMENTS/plan/captions/<lessonId>.json` — un `CaptionsFile` por lección (ver contrato exacto en la sección 2).
4. Para cada lección, sus transcripciones fuente en `jobs/$ARGUMENTS/transcripts/` (el/los `.json` de los clips que componen esa lección) — es tu referencia de lo que el instructor realmente dijo, con más contexto y palabras completas que a veces el caption trae partidas o truncadas.

## 2. Contrato `CaptionsFile` (exacto, no lo cambies)

```ts
interface CaptionWord {
  text: string;
  startFrame: number;
  endFrame: number;
}

interface Caption {
  text: string;
  startFrame: number;
  endFrame: number;
  words: CaptionWord[];
}

interface CaptionsFile {
  lessonId: string;
  fps: number;
  generatedAt: string;
  captions: Caption[];
}
```

Vas a corregir SOLO el campo `text` (del caption y de los `words` correspondientes dentro de él). Todo lo demás del archivo (`lessonId`, `fps`, `captions[].startFrame`, `captions[].endFrame`, `words[].startFrame`, `words[].endFrame`, y el orden/cantidad de elementos en `captions` y `words`) es **intocable**: no lo reordenes, no le agregues ni quites entradas, no cambies ningún número de frame.

## 3. Reglas de corrección (no negociables)

Para CADA caption de CADA `plan/captions/<lessonId>.json`, revísalo contra su transcript fuente y el glosario (global + del job), y aplica ÚNICAMENTE estas correcciones:

1. **Jerga técnica mal escrita**: razas, patologías, anatomía y otros términos especializados del dominio que Whisper transcribió con la pronunciación coloquial del hablante en vez de la grafía correcta (ej. "duro" → "Duroc", "labre" → "la ubre", "distóxico" → "distócico", "erizipela" → "Erisipela", "testerona" → "testosterona", "mamar lostro" → "calostro", "de peles" → "pellets", "Lars White" → "Large White", "York Lras" → "York Landrace", "del P es" → "del PLE"). Normaliza a la grafía correcta AUNQUE el hablante lo haya pronunciado de forma coloquial — la corrección es sobre la transcripción escrita, no sobre lo que se oye.
2. **Palabras partidas entre dos captions consecutivos**: si una palabra quedó cortada al final de un caption y continuada al inicio del siguiente (por el agrupamiento automático de la etapa anterior), corrige el texto de ambos captions para que la palabra quede completa y bien escrita en el caption que le corresponda, sin mover frames.
3. **Duplicaciones**: si el mismo texto quedó repetido de forma espuria (error de transcripción, no un tartamudeo real del hablante — ver regla de abajo), corrige el texto para eliminar la duplicación espuria.

**NUNCA corrijas:**

- **Muletillas** ("o sea", "digamos", "este", "bueno", etc.) — son parte natural del habla del instructor, no un error de transcripción.
- **Tartamudeos reales** (el hablante de verdad repitió o se trabó, ej. "la la vacuna", "el el animal") — eso es fidelidad a lo que se dijo, no un error.
- **Cualquier campo que no sea `text`**: nunca toques `startFrame`, `endFrame` de ningún caption ni de ningún word.

**Consistencia obligatoria**: después de corregir, `caption.text` debe seguir siendo exactamente la unión (con espacios) de los `words[].text` de ese caption, en el mismo orden. Si corriges una palabra dentro de `words`, propaga la corrección a `caption.text`, y viceversa.

Si tienes dudas razonables sobre si algo es jerga mal escrita o un tartamudeo/muleta real, o si el glosario no cubre el caso, prefiere NO tocarlo — el sesgo debe ser conservador: es preferible dejar un error menor sin corregir que reescribir algo que el instructor sí dijo así.

## 4. Salida obligatoria

Para cada `jobs/$ARGUMENTS/plan/captions/<lessonId>.json` que hayas revisado, si hiciste alguna corrección, escríbelo de vuelta in-place con Write (el archivo completo, con las correcciones aplicadas, respetando el contrato de la sección 2). Si no hiciste ninguna corrección en esa lección, no hace falta reescribirlo.

Además, escribe estos dos archivos con Write:

### `jobs/$ARGUMENTS/plan/captions-audit.json`

```ts
interface CaptionsAuditJson {
  auditedAt: string; // ISO timestamp de cuando terminas
  lessons: Array<{
    lessonId: string;
    corrections: Array<{
      index: number; // índice del caption corregido dentro de captions[] (0-based)
      before: string; // caption.text antes de corregir
      after: string; // caption.text después de corregir
      motivo: string; // breve, en español: por qué se corrigió (ej. "jerga: duro -> Duroc (glosario)")
    }>;
  }>; // una entrada por CADA lección revisada, incluso si su array de corrections quedó vacío
}
```

Ejemplo corto:

```json
{
  "auditedAt": "2026-07-21T20:00:00.000Z",
  "lessons": [
    {
      "lessonId": "vacunacion-basica",
      "corrections": [
        {
          "index": 4,
          "before": "es un cerdo duro",
          "after": "es un cerdo Duroc",
          "motivo": "jerga: duro -> Duroc (glosario global)"
        }
      ]
    },
    {
      "lessonId": "manejo-de-la-ubre",
      "corrections": []
    }
  ]
}
```

### `jobs/$ARGUMENTS/plan/glosario.md`

Actualiza (o crea si no existía) el glosario específico de este job con las correcciones NUEVAS que aprendiste en esta corrida (términos que no estaban ya en `config/glosario.md` ni en la versión previa de este archivo). Mismo formato de tabla que `config/glosario.md` (`incorrecto | correcto | contexto`). Si el archivo ya existía, léelo primero (paso 1) y agrégale filas nuevas sin borrar las que ya tenía. Si no aprendiste ningún término nuevo en esta corrida, deja el archivo tal como estaba (no hace falta reescribirlo).

## 5. Invariantes (no negociables)

- `jobs/$ARGUMENTS/transcripts/` es intocable: NUNCA la modifiques. Solo se lee como referencia.
- `startFrame`/`endFrame` de cualquier caption o word: NUNCA se tocan, en ningún archivo.
- Muletillas y tartamudeos reales del hablante: NUNCA se corrigen, aunque "suenen mal" — son fidelidad a la fuente.
- No llames a ninguna API de Anthropic ni uses tokens de facturación: todo el razonamiento lo haces tú, la sesión de Claude Code, con tus herramientas normales (Read/Write).
