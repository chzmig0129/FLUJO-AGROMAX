# Qué está construido y qué falta

Comparación entre el diseño completo del pipeline (16 etapas) y lo que existe
hoy en este repo. Verificado contra el código, no de memoria.

**Resumen: 16 de 16 etapas construidas**, más el orquestador desatendido
(`POST /run-all`) que las encadena todas y la jerarquía de agentes que las
opera. Lo que queda son brechas puntuales de producto (ver más abajo), no
etapas enteras faltantes.

---

## El tablero

| # | Etapa del diseño | Estado | Dónde vive |
|---|---|---|---|
| 1 | Ingest | ✅ **completa** | `src/lib/zip.ts`, `src/app/api/ingest/` |
| 2 | Probe | ✅ **completa** | `src/lib/probe-stage.ts` |
| 3 | Transcribe | ✅ **completa** | `src/lib/transcribe/` |
| 4 | Medir silencio | ✅ **completa** | `src/lib/silence-stage.ts` |
| 5 | Proxies | ✅ **completa** | `src/lib/proxy-stage.ts` |
| 6 | Estructura del curso 🧠 + gate humano | ✅ **completa** | `src/lib/plan/agent.ts`, `src/app/api/jobs/[jobId]/approve/route.ts`, `src/app/api/jobs/[jobId]/structure/route.ts` (PUT) |
| 7 | Conceptos → briefs de overlay | ✅ **completa** | `src/lib/overlay-briefs-stage.ts` |
| 8 | Generar ilustraciones + Gate 1 | ✅ **completa** | `src/lib/overlay-gen-stage.ts` (generación), `src/lib/gate1-stage.ts` (Gate 1) |
| 9 | Intros | ✅ **completa** | `remotion/Intro.tsx` |
| 10 | Cálculo de cortes | ✅ **completa** | `src/lib/cuts-stage.ts` |
| 11 | Ensamblaje | ✅ **completa** — video, captions y overlays, con dos backends | `src/lib/assembly/`, `remotion/Lesson.tsx` (compone `Captions` y `Overlays`), `src/lib/overlays-timeline-stage.ts`, `src/lib/captions-stage.ts` |
| 12 | Auditoría de subtítulos | ✅ **completa** | `src/lib/captions-audit-stage.ts` |
| 13 | Export | ✅ **completa** (y más estricta que el diseño) | `src/lib/assembly/verify.ts` |
| 14 | Gate 2 — QA visual por clase | ✅ **completa** | `src/lib/gate2-stage.ts` (juez), `src/lib/gate2-frames-stage.ts` (frames del render final, incluidos frames dirigidos a intro/captions) |
| 15 | Gate 3 — revisión por módulo | ✅ **completa** | `src/lib/gate3-stage.ts` |
| 16 | Empaquetado y entrega | ✅ **completa** | `src/lib/package-stage.ts` (arma `deliver/CURSO_<slug>/` con `.mp4` renombrado, `NOTAS.md` por clase y `deliver/manifest.json`) |

---

## El orquestador y la jerarquía de agentes (lo que no estaba en el doc anterior)

**Orquestador desatendido — `POST /api/jobs/[jobId]/run-all`.** Llama a
`runFullPipeline` en `src/lib/pipeline.ts`, que encadena TODAS las etapas de
arriba sobre un job ya aprobado (o con `AUTO_APPROVE=1`): prep (silencio +
proxies en paralelo, luego cortes y captions) → auditoría de subtítulos (si
aplica) → briefs de overlay → generación de overlays (se salta sin cortar la
cadena si el CDP no está disponible) → Gate 1 (con el director de edición si
hay rechazos) → overlays-timeline → ensamblaje → Gate 2 de todas las clases en
paralelo (con el director si hay rechazos) → Gate 3 por módulo → empaquetado.
Cualquier error real dentro de esa cadena deja el job en `status: "error"`
con el mensaje de en qué eslabón falló; un veredicto `REJECTED` no es un
error, es un resultado esperado del QA que dispara al director.

**Jerarquía de modelos por rol — `src/lib/plan/claude-code-engine.ts`.** El
motor genérico que corren los comandos headless de Claude Code (`/briefs-
overlays`, `/gate1-overlays`, `/gate2-clase`, `/gate3-modulo`, `/auditar-
subtitulos`, `/director-edicion`) elige el modelo según el rol invocado:
`director` y `editor` usan `CLAUDE_MODEL_DIRECTOR`/`CLAUDE_MODEL_EDITOR`
(default `claude-opus-4-8`), `juez` usa `CLAUDE_MODEL_JUEZ` (default
`claude-sonnet-5`) — los veredictos de QA no necesitan el modelo más caro,
las correcciones sí. `runCommandsInPool` (mismo archivo) corre varios
comandos headless en paralelo con un límite de concurrencia; lo usa
`gate2-stage.ts` para juzgar todas las clases de una corrida a la vez
(`gate2-all`) en vez de una por una.

**El director de edición — `src/lib/director-stage.ts` +
`.claude/commands/director-edicion.md`.** Es el "jefe" que lee todos los
veredictos de QA de un job (Gate 1, Gate 2, Gate 3, auditoría de subtítulos),
decide y ejecuta el fix para cada rechazo bloqueante, re-dispara las etapas
necesarias y re-juzga, con un loop de **hasta 3 vueltas** documentado en el
propio comando: si tras 3 vueltas sigue habiendo rechazos, los reporta como
"irresolubles" en vez de seguir insistiendo indefinidamente.

---

## Backend de ensamblaje: Remotion y Palmier, los dos operativos

El diseño original recomendaba empezar por Palmier (NLE con soporte nativo de
captions/keyframes/export) y agregar el backend headless (Remotion) después,
cuando la concurrencia fuera el cuello de botella. Acá se hizo al revés:
Remotion se construyó primero porque el ensamblaje que hacía falta al
arrancar (concatenar tramos con una portada, sin overlays ni captions
todavía) eran horas de trabajo en Remotion, no las semanas que costaría
reconstruir esas features en un NLE.

Hoy **los dos backends están operativos**, detrás de la misma interfaz
(`ASSEMBLY_BACKEND`, ver `src/lib/assembly/index.ts`):

- `ASSEMBLY_BACKEND=remotion` (default): headless, sirve para corridas
  desatendidas en CI/lote. `src/lib/assembly/remotion/backend.ts`.
- `ASSEMBLY_BACKEND=palmier`: controla la app de escritorio Palmier vía su
  MCP (`src/lib/assembly/palmier/mcp-client.ts`, `backend.ts`,
  `captions.ts`, `overlays.ts` — ~1360 líneas entre los cuatro archivos, con
  retry/backoff para "editor busy", asset lookup, offset de intro real y
  re-fijado de resolución tras `add_clips`). **No es un stub**: es el backend
  que se usa para abrir un curso ya ensamblado en un editor de verdad y
  retocarlo a mano.

---

## Brechas reales (verificadas, no las etapas — las etapas ya existen)

Estas son las carencias puntuales que quedan hoy, no bloques enteros del
diseño:

| Falta | Impacto |
|---|---|
| **`order.json` al subir** (orden y títulos que da el usuario) | El planificador (`plan/agent.ts`) sigue infiriendo la secuencia de clases por nombre de archivo y contenido, no por un orden explícito del usuario |
| **Checksums en la ingesta** | No hay hashing de los archivos subidos (`src/lib/zip.ts`, `src/app/api/ingest/`); sin deduplicación ni cache keys entre corridas |
| **B-roll dentro de una clase, en cualquier punto** | El planificador (`src/lib/plan/prompt.ts`) ya asigna los clips de B-roll como segmento de apoyo, pero siempre **al final** de la lección afín (`topic: "B-roll: <qué se ve>"`); no hay forma de declarar "insertá este B-roll a los 2:00, mudo, en medio de la narración" |

Las brechas grandes que el documento anterior marcaba —capas de overlay,
subtítulos, los tres gates, el gate humano de estructura, el empaquetado, el
paralelismo silencio/proxies— **ya no existen**: son las etapas 7, 8, 11, 12,
14, 15, 16 de la tabla de arriba, y el paralelismo entre silencio y proxies
está resuelto en `runPrepStages` (`src/lib/pipeline.ts`) con un
`Promise.all`.

---

## Qué sigue, en orden de valor

1. **`order.json` al subir.** Es la brecha con más impacto en la calidad del
   plan por menos esfuerzo: le da al planificador la secuencia real en vez de
   inferirla.
2. **B-roll insertable en cualquier punto de una clase**, no solo al final.
   Requiere que la estructura pueda declarar un punto de inserción y que el
   ensamblaje (`src/lib/assembly/plan.ts`) sepa partir un tramo "keep" para
   dejarle lugar.
3. **Checksums en la ingesta**, para deduplicar material entre corridas del
   mismo curso y habilitar cache keys reales.

---

## Última corrida

Pendiente: se completa al cerrar la corrida OVINOS en curso.
