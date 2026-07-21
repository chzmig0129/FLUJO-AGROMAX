/**
 * schemas.ts — JSON Schemas (formato "strict" de Anthropic) de las dos tools
 * que usa el agente autónomo de la etapa 4 (plan/filtro editorial):
 *
 * - `extraer_frames`: le permite al agente pedir frames adicionales de UN
 *   clip cuando su confianza es baja y los frames iniciales no le alcanzan
 *   para decidir.
 * - `entregar_resultado`: es la única forma en que el agente entrega su
 *   veredicto final (verdicts + structure + decisiones.md); el loop del
 *   agente termina cuando esta tool se invoca.
 *
 * Ambos esquemas usan additionalProperties:false y `required` completo
 * (todas las claves de `properties`), como exige el modo strict de tools de
 * Anthropic.
 */

/** Schema de la tool `extraer_frames`: pide frames extra de un clip puntual. */
export const extraerFramesInputSchema = {
  type: "object",
  properties: {
    clip: {
      type: "string",
      description:
        "Nombre de archivo del clip tal como aparece en frames/manifest.json (ej. 'IMG_0527.MOV').",
    },
    everySeconds: {
      type: ["number", "null"],
      description:
        "Extraer un frame cada N segundos dentro del rango pedido. Usar null si no aplica.",
    },
    count: {
      type: ["number", "null"],
      description:
        "Extraer N frames distribuidos uniformemente dentro del rango pedido. Usar null si no aplica.",
    },
    startSeconds: {
      type: ["number", "null"],
      description:
        "Inicio del rango en segundos (por defecto 0). Usar null si no aplica.",
    },
    endSeconds: {
      type: ["number", "null"],
      description:
        "Fin del rango en segundos (por defecto la duración del clip). Usar null si no aplica.",
    },
  },
  required: ["clip", "everySeconds", "count", "startSeconds", "endSeconds"],
  additionalProperties: false,
} as const;

/** Schema de un veredicto individual (mismo shape que el tipo Verdict de types.ts). */
const verdictSchema = {
  type: "object",
  properties: {
    clip: {
      type: "string",
      description: "Nombre de archivo del clip juzgado.",
    },
    verdict: {
      type: "string",
      enum: ["leccion", "broll", "descartar", "otro_curso"],
      description:
        "leccion: material utilizable. broll: apoyo visual sin narración propia. descartar: inservible/retake viejo/basura. otro_curso: pertenece a un curso distinto.",
    },
    curso: {
      type: ["string", "null"],
      description:
        "Nombre del curso al que pertenece el clip (o al que pertenecería si es otro_curso). null si no aplica.",
    },
    razon: {
      type: "string",
      description: "Explicación breve en español del veredicto.",
    },
    confianza: {
      type: "number",
      description: "Confianza del veredicto entre 0 y 1.",
    },
    heuristicas: {
      type: "array",
      items: { type: "string" },
      description:
        "IDs (kebab-case) de las secciones de config/domain-heuristics.md que se usaron como pista, si alguna.",
    },
  },
  required: ["clip", "verdict", "curso", "razon", "confianza", "heuristicas"],
  additionalProperties: false,
} as const;

/** Schema de un segmento dentro de una lección: rango de tiempo en un clip fuente. */
const segmentSchema = {
  type: "object",
  properties: {
    clip: { type: "string", description: "Clip fuente del segmento." },
    startSeconds: { type: "number", description: "Inicio del segmento en segundos." },
    endSeconds: { type: "number", description: "Fin del segmento en segundos." },
    topic: { type: "string", description: "Tema puntual cubierto por este segmento." },
  },
  required: ["clip", "startSeconds", "endSeconds", "topic"],
  additionalProperties: false,
} as const;

/** Schema de una lección: agrupa segmentos bajo un título y orden dentro de su módulo. */
const lessonSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Identificador estable (kebab-case) de la lección." },
    title: { type: "string", description: "Título de la lección." },
    order: { type: "number", description: "Orden de la lección dentro del módulo." },
    segments: {
      type: "array",
      items: segmentSchema,
      description: "Segmentos (rangos de tiempo en clips fuente) que componen la lección.",
    },
  },
  required: ["id", "title", "order", "segments"],
  additionalProperties: false,
} as const;

/** Schema de un módulo: agrupa lecciones bajo un tema del curso. */
const moduleSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Identificador estable (kebab-case) del módulo." },
    title: { type: "string", description: "Título del módulo." },
    order: { type: "number", description: "Orden del módulo dentro del curso." },
    topics: {
      type: "array",
      items: { type: "string" },
      description: "Lista de temas cubiertos por el módulo.",
    },
    lessons: {
      type: "array",
      items: lessonSchema,
      description: "Lecciones del módulo.",
    },
  },
  required: ["id", "title", "order", "topics", "lessons"],
  additionalProperties: false,
} as const;

/**
 * Schema de la tool `entregar_resultado`: la única forma en que el agente
 * entrega su trabajo final. Incluye TODOS los veredictos (uno por clip
 * juzgado, incluyendo los descartados o de otro curso), la estructura
 * propuesta del curso, y el markdown de decisiones para revisión humana.
 */
export const entregarResultadoInputSchema = {
  type: "object",
  properties: {
    courseTitle: {
      type: "string",
      description: "Título propuesto para el curso principal.",
    },
    verdicts: {
      type: "array",
      items: verdictSchema,
      description:
        "Un veredicto por CADA clip del job (leccion, broll, descartar u otro_curso).",
    },
    modules: {
      type: "array",
      items: moduleSchema,
      description:
        "Módulos del curso principal, cada uno con sus lecciones y segmentos.",
    },
    decisionesMd: {
      type: "string",
      description:
        "Documento en Markdown (español) explicando las decisiones tomadas, con la sección '⚠️ Baja confianza' primero si aplica.",
    },
  },
  required: ["courseTitle", "verdicts", "modules", "decisionesMd"],
  additionalProperties: false,
} as const;
