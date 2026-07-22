---
description: Juez de QA "Gate 3" de un módulo completo — coherencia entre sus clases + consistencia visual cross-clase, mirando frames muestreados de varias lecciones a la vez con visión (Read) y decidiendo APPROVED/REJECTED, usando la suscripción de Claude Code, sin usar la API de Anthropic.
---

Job y módulo a procesar: `$ARGUMENTS` — dos tokens separados por espacio: `<jobId> <moduleId>` (ej. `abc123 modulo-vacunacion`).

Tú (la sesión de Claude Code) ERES el juez de QA de módulo de la etapa "Gate 3" del diseño. A diferencia de Gate 2 (que audita UNA clase ya renderizada), acá auditas el MÓDULO completo: si sus clases tienen sentido en secuencia, si los títulos coinciden con lo planeado, y si el resultado visual es consistente entre clases distintas. No hay llamada a la API de Anthropic ni tool-runner: MIRAS los frames con tu propia herramienta Read (tienes visión sobre imágenes PNG), razonas, y al final escribes tú mismo el veredicto con Write.

## 0. Verificación previa

Antes de nada, confirma que hay algo que auditar:

- `jobs/<jobId>/qa/gate3/frames/<moduleId>/manifest.json` debe existir. Si no, DETENTE y reporta que falta la etapa de muestreo de frames de Gate 3 — no inventes datos ni un veredicto.

## 1. Leer las entradas

Lee, en este orden, con la herramienta Read:

1. `jobs/<jobId>/plan/structure.json` — el `StructureJson` completo del job. Ubica el módulo con `id === <moduleId>` en `modules`. Este es tu **cotejo obligatorio**: el `title` y el `order` de cada lección del módulo, tal como quedaron en `structure.json`, son la fuente de verdad de cómo DEBERÍAN llamarse y ordenarse las clases. Si el módulo `<moduleId>` no aparece en `structure.json`, DETENTE y repórtalo como error — no sigas con una auditoría a ciegas.
2. `jobs/<jobId>/qa/gate3/frames/<moduleId>/manifest.json` — contrato:

   ```ts
   interface Gate3FramesManifest {
     moduleId: string;
     generatedAt: string;
     frames: Array<{
       file: string; // nombre del PNG dentro del mismo directorio que el manifest
       lessonId: string; // lección (dentro del módulo) de la que se extrajo
       timeSeconds: number; // timestamp dentro de render/<lessonId>.mp4
     }>;
   }
   ```

3. Para CADA lección distinta que aparezca en `frames` del manifest, lee `jobs/<jobId>/render/<lessonId>.json` (el `RenderSidecar` de esa clase) para saber su `durationSeconds` real — es tu referencia de duración por clase para el check (c) de abajo. Si falta ese sidecar para alguna lección, sigue igual con las demás pero anótalo como hallazgo menor (dato de duración no disponible).
4. Opcionalmente, si necesitas más contexto de una clase puntual (por ejemplo para confirmar un tema huérfano o duplicado), lee `jobs/<jobId>/plan/cuts/<lessonId>.json` y/o `jobs/<jobId>/plan/captions/<lessonId>.json` de esa lección — no es obligatorio para todas, solo para las dudosas.

## 2. Mirar los frames de todas las clases del módulo

Para CADA entrada de `frames` en el manifest, usa Read sobre `jobs/<jobId>/qa/gate3/frames/<moduleId>/<file>` (la ruta es relativa al directorio del manifest) para VER la imagen. No te saltes ninguna — el objetivo es tener frames de TODAS las lecciones del módulo a la vista al mismo tiempo, para poder comparar entre ellas.

## 3. Checks del diseño

### (a) Coherencia de módulo

Cotejando contra `structure.json`:

- ¿Las clases del módulo, en el orden (`order`) que aparecen en `structure.json`, tienen sentido como secuencia pedagógica (de lo básico a lo avanzado, sin saltos temáticos raros)?
- ¿Algún tema (`topics` del módulo, o el tema de una lección puntual) parece huérfano (no lo cubre ninguna clase) o duplicado (dos clases cubriendo lo mismo sin razón aparente)?
- ¿Los títulos (`title`) y la numeración (`order`) de las lecciones que ves reflejadas en los frames (si el video muestra texto de título/intro) coinciden con lo que dice `structure.json`? Si un frame de intro muestra un título distinto al de `structure.json`, es un hallazgo.

### (b) Consistencia visual entre frames de distintas clases

Comparando los frames entre sí (no cada uno de forma aislada):

- ¿El estilo de subtítulo (fuente, tamaño, color, contraste) es el mismo en todas las clases del módulo, o hay una clase que se ve distinta al resto?
- ¿La posición del subtítulo en pantalla es consistente entre clases?
- ¿Hay saltos visuales raros entre clases (cambio brusco de iluminación/color de fondo que sugiera un problema de render, framing muy distinto entre una clase y otra sin razón aparente)?

### (c) Duraciones

Usando `durationSeconds` de cada `render/<lessonId>.json` leído en el paso 1.3:

- Cada clase del módulo debe durar entre 3 y 14 minutos (180 a 840 segundos). Si alguna cae fuera de ese rango, es un hallazgo (severidad `menor` si está apenas fuera del rango, `bloqueante` si está muy lejos — por ejemplo, una "clase" de 30 segundos o de 40 minutos sugiere un error real de estructura o de render).

## 4. Salida obligatoria

Escribe con Write, en `jobs/<jobId>/qa/gate3/<moduleId>.json`:

```ts
interface Gate3Verdict {
  moduleId: string;
  auditedAt: string; // ISO timestamp de cuando terminas
  verdict: "APPROVED" | "REJECTED";
  hallazgos: Array<{
    tipo: "coherencia" | "visual" | "duracion";
    detalle: string; // descripción breve y concreta en español
    severidad: "bloqueante" | "menor";
    lessonId?: string; // si el hallazgo apunta a una clase concreta del módulo
  }>;
}
```

Reglas del veredicto:

- `verdict` es `"REJECTED"` si `hallazgos` tiene **al menos un** hallazgo con `severidad: "bloqueante"`. Si solo hay hallazgos `"menor"` (o ninguno), `verdict` es `"APPROVED"`.
- Si no encontraste ningún problema, `hallazgos` es un array vacío `[]` y `verdict` es `"APPROVED"`.

Además, APPEND legible a `jobs/<jobId>/qa/QA_LOG.md` (créalo si todavía no existe) con una entrada nueva: fecha (ISO), módulo (`moduleId`), veredicto, y la lista de hallazgos (o "sin hallazgos" si `hallazgos` está vacío). No borres ni reescribas entradas previas del log — solo agregás la tuya al final.

## 5. Invariantes (no negociables)

- No emitas un veredicto sin haber cotejado títulos y numeración de las lecciones del módulo contra `plan/structure.json` primero (regla de la sección 3.a) — no inventes coherencia a ojo sin esa referencia.
- No llames a ninguna API de Anthropic ni uses tokens de facturación: todo el razonamiento y la visión los haces tú, la sesión de Claude Code, con tus herramientas normales (Read/Write).
- No modifiques `plan/structure.json`, el manifest de frames, ningún PNG, ni `render/<lessonId>.json` — esta etapa es de solo lectura + dos archivos de salida (`qa/gate3/<moduleId>.json` y el append a `qa/QA_LOG.md`).
