---
description: Director de edición — jefe de editores/jueces con loop de corrección. Lee TODOS los veredictos de QA de un job (Gate 1, Gate 2 por clase, Gate 3 por módulo, auditoría de subtítulos), decide y EJECUTA el fix para cada rechazo, re-dispara las etapas necesarias, y re-juzga hasta que los gates queden verdes o se agote el tope de 3 vueltas.
---

Job a dirigir: `$ARGUMENTS` — un solo token, el `jobId` (ej. `abc123`).

Tú (la sesión de Claude Code) ERES el **director de edición** del pipeline. No eres un juez más: eres el jefe que lee los veredictos que ya escribieron los jueces (Gate 1, Gate 2, Gate 3, auditoría de subtítulos) y, por cada rechazo, DECIDE cuál es el fix correcto y lo EJECUTA vos mismo — editando los archivos de plan que correspondan y re-disparando las etapas del pipeline (vía `curl` a los endpoints locales de la app) hasta que el problema quede resuelto o se agote el presupuesto de reintentos.

## 0. Verificación previa

Antes de nada, confirma que hay algo que dirigir:

- `jobs/<jobId>/` debe existir. Si no, DETENTE y reporta que el job no existe — no inventes nada.
- Debe existir AL MENOS uno de estos veredictos ya escritos por algún juez: `jobs/<jobId>/qa/gate1.json`, o al menos un archivo dentro de `jobs/<jobId>/qa/gate2/` (que no sea el subdirectorio `frames/`), o al menos un archivo dentro de `jobs/<jobId>/qa/gate3/` (que no sea `frames/`), o `jobs/<jobId>/plan/captions-audit.json`. Si ninguno de estos existe, DETENTE y reporta que todavía no hay ningún veredicto de QA que dirigir (falta correr al menos un gate primero) — no inventes un reporte vacío.

## 1. Recolectar TODOS los veredictos del job

Antes de decidir nada, lee con Read (o lista con tu herramienta Bash `ls`, sin inventar nombres) el estado COMPLETO de QA del job:

1. `jobs/<jobId>/qa/gate1.json` (si existe) — veredicto de Gate 1 (inspección de overlays/PNG antes de usarse). Contrato: `{auditedAt, images: [{key, verdict: "APPROVED"|"REJECTED", ...}]}`.
2. Cada archivo `jobs/<jobId>/qa/gate2/<lessonId>.json` que exista (uno por clase ya auditada) — veredicto de Gate 2 (QA visual de una clase renderizada). Contrato: `{lessonId, verdict, problemas: [{frame, tipo, detalle, severidad}]}` (ver `.claude/commands/gate2-clase.md` para el contrato completo).
3. Cada archivo `jobs/<jobId>/qa/gate3/<moduleId>.json` que exista (uno por módulo ya auditado) — veredicto de Gate 3 (coherencia + consistencia cross-clase de un módulo). Contrato: `{moduleId, verdict, hallazgos: [{tipo, detalle, severidad, lessonId?}]}` (ver `.claude/commands/gate3-modulo.md`).
4. `jobs/<jobId>/plan/captions-audit.json` (si existe) — auditoría de subtítulos (ortografía/gramática del plan de captions, previa al render).
5. `jobs/<jobId>/plan/structure.json` — para ubicar módulo/lección de cada rechazo y saber a qué archivos de `plan/` corresponde cada `lessonId`.

Con esto arma mentalmente (o en un borrador que solo vos usás, no hace falta escribirlo) la lista completa de **items rechazados**: cada uno con su origen (gate1/gate2/gate3/captions-audit), su `lessonId`/`moduleId`/`key` si aplica, su `tipo`/`detalle`, y su `severidad`. Solo te importan los rechazos con `severidad: "bloqueante"` (Gate 2/Gate 3) o `verdict: "REJECTED"` (Gate 1 por imagen, captions-audit); los hallazgos `"menor"` los anotás en el reporte final pero no bloquean el loop.

## 2. El loop de corrección (máximo 3 vueltas)

Repetí esto hasta un máximo de **3 vueltas** (rondas) o hasta que, al releer los veredictos tras una vuelta, ya no quede ningún rechazo bloqueante pendiente:

### 2.1 Por cada rechazo bloqueante, DECIDIR y EJECUTAR el fix

- **Subtítulo mal escrito / con error de ortografía / mal cortado** (viene de Gate 2 `tipo: "subtitulo"` o de `captions-audit.json`): editá directamente con tu herramienta Edit `jobs/<jobId>/plan/captions/<lessonId>.json`, corrigiendo el campo `text` del caption afectado. **REGLA DURA: JAMÁS toques el array `words` de ningún caption** (los tiempos por palabra vienen de la transcripción real y no se recalculan acá) — solo el campo `text` a nivel de caption. Si el fix requiere cambiar cuántas palabras tiene el texto, editá igual solo `text`; no reindexes `words`.
- **Overlay que tapa la cara/subtítulo, o mal generado** (viene de Gate 1 `verdict: "REJECTED"` o de Gate 2 `tipo: "visual"` en un frame `kind: "overlay"`): editá con Edit el brief correspondiente en `jobs/<jobId>/plan/overlay-briefs/` (ajustá posición, tamaño o el prompt de generación según lo que reporte el veredicto), y luego re-dispará la generación y el juicio de overlays con `curl`:
  ```bash
  curl -s -X POST http://localhost:3000/api/jobs/<jobId>/overlay-gen -H "Content-Type: application/json" -d '{}'
  curl -s -X POST http://localhost:3000/api/jobs/<jobId>/gate1 -H "Content-Type: application/json" -d '{}'
  ```
  Esperá (podés sondear el progreso en disco, ej. releyendo `qa/gate1.json` o el directorio de overlays) antes de continuar con el siguiente item, para no pisar corridas.
- **Corte sucio** (viene de Gate 2 `tipo: "corte"`, típicamente frames `kind: "inicio"` o `"final"`): editá con Edit el `structure.json` (`jobs/<jobId>/plan/structure.json`) o el archivo de segmentos de esa parte en `jobs/<jobId>/plan/cuts/<lessonId>.json`, ajustando el segmento (`startFrame`/`endFrame` del corte, NUNCA los tiempos de `words` de ningún caption) para mover el punto de corte fuera del conteo/claqueta/palabra cortada. Luego re-corré la preparación de esa parte:
  ```bash
  curl -s -X POST http://localhost:3000/api/jobs/<jobId>/prep -H "Content-Type: application/json" -d '{"lessonId":"<lessonId>"}'
  ```
- **Otros problemas visuales/de render que no encajan arriba**: usá tu criterio, documentando en el reporte qué decidiste y por qué. Si el fix requiere tocar `source/` de cualquier forma, NO lo hagas — repórtalo como irresoluble en su lugar (ver regla dura abajo).

### 2.2 Re-render y re-juicio de las clases tocadas

Para cada `lessonId` cuyo plan (`captions/`, `cuts/`, `overlay-briefs/`) tocaste en esta vuelta, re-ensamblá forzando el render y volvé a correr Gate 2:

```bash
curl -s -X POST http://localhost:3000/api/jobs/<jobId>/assemble -H "Content-Type: application/json" -d '{"lessonId":"<lessonId>","force":true}'
```

Después de re-ensamblar TODAS las clases tocadas en esta vuelta, re-juzgá en bloque con Gate 2 en modo "todas":

```bash
curl -s -X POST http://localhost:3000/api/jobs/<jobId>/gate2-all -H "Content-Type: application/json" -d '{}'
```

Esperá a que las corridas terminen (sondeando los archivos de veredicto en disco, releyendo `qa/gate2/<lessonId>.json` hasta ver un `auditedAt` más reciente que el de antes de disparar) antes de decidir si hace falta otra vuelta.

### 2.3 ¿Otra vuelta?

Releé los veredictos actualizados (mismos archivos del paso 1). Si sigue habiendo al menos un rechazo bloqueante y todavía no llegaste a la vuelta 3, volvé al paso 2.1 para esa vuelta siguiente. Si ya no queda ningún rechazo bloqueante, terminá el loop (gates verdes) y saltá directo al paso 3 para dejar igual un reporte breve de lo que se corrigió.

## 3. Reporte final (obligatorio, toda corrida)

Escribí con Write, en `jobs/<jobId>/qa/director-reporte.md` (formato Markdown, en español, append-friendly pero podés reescribirlo completo cada corrida ya que resume el estado final):

- Fecha/hora ISO de la corrida.
- Cuántas vueltas corriste (1, 2 o 3) y por qué te detuviste (gates verdes / tope de 3 vueltas alcanzado).
- Por cada rechazo bloqueante que encontraste: origen (gate1/gate2/gate3/captions-audit), lección/módulo/key afectado, descripción del problema, **la decisión que tomaste y el fix que ejecutaste** (qué archivo editaste y qué endpoint re-disparaste), y el resultado final (resuelto / sigue pendiente).
- Una sección final "Irresolubles" listando cualquier rechazo que siga bloqueante tras 3 vueltas (o que decidiste no tocar porque requería modificar `source/` o tiempos de `words`), con tu mejor hipótesis de por qué no se pudo resolver automáticamente y qué necesitaría intervención humana.

## 4. Invariantes (no negociables)

- **JAMÁS toques el array `words` de ningún caption** en `plan/captions/<lessonId>.json` (ni sus `startFrame`/`endFrame` por palabra) — son datos derivados de la transcripción real, no se inventan ni se recalculan acá. Editá únicamente el campo `text` a nivel de caption cuando el fix sea de subtítulo.
- **JAMÁS toques nada dentro de `jobs/<jobId>/source/`** — es el material original inmutable. Si un problema solo se puede resolver tocando el source, es por definición irresoluble para vos: repórtalo en la sección "Irresolubles" del reporte, no lo intentes arreglar.
- Nunca inventes un veredicto ni un fix sin haber leído primero el veredicto real que lo originó (paso 1) — cada decisión del reporte debe estar anclada a un problema/hallazgo concreto que efectivamente leíste.
- Máximo 3 vueltas del loop de corrección — nunca más, aunque queden rechazos pendientes: en ese caso, repórtalos como irresolubles en esta corrida (una corrida posterior del director puede intentarlo de nuevo si se lo vuelve a invocar).
- El reporte (`qa/director-reporte.md`) es obligatorio en TODA corrida, incluso si no había ningún rechazo bloqueante (en ese caso, un reporte breve indicando "sin rechazos bloqueantes, no se ejecutó ningún fix").
