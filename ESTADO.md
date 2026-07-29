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

## Última corrida — re-corrida DEFINITIVA (julio 2026)

**OVINOS_AGROMAX — job `891533f3-29cc-4fe1-9923-fce82115a5c2`.** Curso de 43
clases en 6 módulos (Manejo diario 7, Instalaciones 6, Razas 3, Reproducción
7, Nutrición 18, Sanidad 2), ~211 min. Corrida en la PC (`ssh itg`,
`C:\FLUJO-AGROMAX`, backend `remotion` headless, UI
`https://itg.tailf75570.ts.net`).

Esta re-corrida rehízo el render completo con el **código final** (overlays
con límite de altura, anclados esquina superior izquierda) y **corrigió dos
overlays** que Gate 1 había rechazado por contenido ajeno al tema —no por la
paloma, que ya estaba resuelta:

- **`macro_y_microminerales`** (clase `vitaminas-y-minerales`): el modelo
  había escrito la fórmula NPK de fertilizante agrícola («nitrógeno, fósforo,
  potasio») en vez de los macrominerales de nutrición animal. Corregido a
  **calcio, fósforo, sodio, potasio, magnesio, azufre**.
- **`ventajas_de_inseminar`** (clase `laparoscopia-fundamentos`): la tarjeta 3
  dibujaba una **cabra** en vez de un borrego y llevaba una X roja que
  contradecía el título. Corregido a **dos borregos lanudos** con las tres
  tarjetas en palomita verde.

Ambos se regeneraron vía Chrome CDP (puerto 9223, cuenta Pro; el 9222 quedó
caído) usando `.venv-overlays\Scripts\python.exe` (el `python` pelado de la PC
no tiene playwright), se procesaron a PNG, se verificaron visualmente, se
marcaron `APPROVED` en `qa/gate1.json` y se reconstruyó el `overlays-timeline`
(que reveló, de paso, que `vitaminas-y-minerales` tenía el timeline **vacío**
—le faltaban todos sus overlays en el render viejo—). Solo esas 2 clases más
otras 2 que habían fallado por proxy se re-renderizaron; las 39 restantes se
conservaron por huella (fingerprint) válida.

**Incidentes operativos resueltos durante la corrida** (documentados en las
memorias `bd`):

- **Disco lleno (210 GB → 2 GB).** Cada render de Remotion crea ~13-18 GB de
  frames temporales en `%TEMP%\agromax-remotion-<job>-<pid>`; al matar `node`
  entre reinicios, esas carpetas quedaban huérfanas y se acumularon ~110 GB,
  reventando los renders con un error engañoso de «Chrome rejecting the request
  because disk space is low». Se borraron las huérfanas (las de PID muerto) →
  disco de vuelta en ~94 GB.
- **Concurrencia.** `REMOTION_CONCURRENCY=10` subió el uso de CPU de 30 % a
  ~60 % (la GPU queda en 0 %: Remotion rasteriza los frames en Chrome por
  software y encodea con libx264, no usa la RTX 2060), pero 10 seeks
  simultáneos sobre los proxies grandes (~500 MB) de Nutrición tumbaban el
  servidor de proxies. Se bajó a **6**, punto dulce estable: ~1.5× más rápido
  que 4 y sin fallos.

**Resultados verificados esta corrida:**

- Render: **43/43 MP4**, `job = assembled`, `error: null`, **0 errores** en la
  corrida final a concurrencia 6.
- **Gate 1: 136/136 overlays `APPROVED`** (los 2 corregidos incluidos).
- **Gate 2: 43/43 clases `APPROVED`** (0 rechazos, re-juzgadas sobre el render
  nuevo).
- **Gate 3: 6/6 módulos `APPROVED`** (`manejo-diario`, `instalaciones`,
  `razas`, `reproduccion`, `nutricion`, `sanidad`) — el tail (Gate 3 +
  empaquetado) se corrió con Codex e incorporó estos re-renders.
- **Empaquetado / entrega: completa.**
  `jobs/891533f3-29cc-4fe1-9923-fce82115a5c2/deliver/CURSO_OVINOS_AGROMAX/`
  con 6 módulos, **43 MP4**, 43 `NOTAS.md`, `ESTRUCTURA_CURSO.md`, `QA_LOG.md`,
  `DECISIONES.md` y `deliver/manifest.json` (43 lecciones).

> **Verificado:** los 43/43 MP4 entregados coinciden en tamaño con sus
> renders fuente (0 mismatch), incluidas las 4 clases re-renderizadas esta
> corrida —`laparoscopia-fundamentos`, `vitaminas-y-minerales`,
> `minerales-vitaminas-y-aditivos`, `conversion-y-eficiencia-alimenticia`—.
> O sea, la entrega final **contiene los overlays corregidos** (macrominerales
> animales y borregos, ya sin el NPK ni la cabra).
