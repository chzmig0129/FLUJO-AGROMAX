---
description: Juez de QA visual "Gate 2" de una clase ya renderizada — mira los frames muestreados de la etapa 15 con visión (Read) y decide APPROVED/REJECTED, usando la suscripción de Claude Code, sin usar la API de Anthropic.
---

Job y lección a procesar: `$ARGUMENTS` — dos tokens separados por espacio: `<jobId> <lessonId>` (ej. `abc123 vacunacion-basica`).

Tú (la sesión de Claude Code) ERES el juez de QA visual de la etapa "Gate 2" del diseño. No hay llamada a la API de Anthropic ni tool-runner: MIRAS cada frame con tu propia herramienta Read (tienes visión sobre imágenes PNG), razonas, y al final escribes tú mismo el veredicto con Write.

## 0. Verificación previa

Antes de nada, confirma que hay algo que auditar:

- `jobs/<jobId>/qa/gate2/frames/<lessonId>/manifest.json` debe existir. Si no, DETENTE y reporta que falta la etapa de muestreo de frames de Gate 2 — no inventes datos ni un veredicto.

## 1. Leer las entradas

Lee, en este orden, con la herramienta Read:

1. `jobs/<jobId>/qa/gate2/frames/<lessonId>/manifest.json` — contrato:

   ```ts
   interface Gate2FramesManifest {
     lessonId: string;
     generatedAt: string;
     videoPath: string;
     durationSeconds: number;
     frames: Array<{
       file: string; // nombre del PNG dentro del mismo directorio que el manifest
       kind: "intro" | "caption" | "random" | "overlay" | "inicio" | "final";
       timeSeconds: number;
     }>;
   }
   ```

2. `jobs/<jobId>/plan/captions/<lessonId>.json` — el `CaptionsFile` de esta lección (contrato: `{lessonId, fps, generatedAt, captions: [{text, startFrame, endFrame, words}]}`). Lo usas como referencia exacta de qué texto DEBE verse en pantalla en cada instante — necesitas `fps` para convertir `startFrame`/`endFrame` a segundos (`frame / fps`) y así saber qué caption le toca a cada `timeSeconds` del manifest. **También es la referencia para el checklist de frames `overlay`**: el caption activo en el `timeSeconds` de ese overlay es "de lo que está hablando" el instructor en ese momento.
3. `config/glosario.md` (raíz del repo) — glosario semilla de ortografía del dominio. Si no existe, sigue solo con tu propio criterio.
4. `jobs/<jobId>/plan/glosario.md` — glosario específico de este job, si existe.

## 2. Mirar cada frame

Para CADA entrada de `frames` en el manifest, usa Read sobre `jobs/<jobId>/qa/gate2/frames/<lessonId>/<file>` (la ruta es relativa al directorio del manifest) para VER la imagen. No te saltes ninguna.

### Checklist por frame

Para cada frame, evalúa:

1. **Subtítulo legible**: si a ese `timeSeconds` debería haber un caption visible (según el cálculo de frame → segundos del paso 1.2), confirma que el texto se ve nítido, con buen contraste, sin cortarse en los bordes.
2. **Letras no fusionadas**: que las letras del subtítulo no se vean pegadas/superpuestas entre sí (defecto típico de render de texto).
3. **Bien escrito — cotejado contra el caption esperado**: calcula qué caption corresponde a ese `timeSeconds` (por rango `startFrame`/`endFrame` convertido a segundos) y compara el texto que ves en el frame contra `caption.text` de ese JSON, apoyándote en el glosario para dudas de ortografía técnica. **REGLA DE COSTO** (no negociable): si un texto se ve dudoso o borroso en el thumbnail, NO reportes un defecto de ortografía sin antes cotejarlo contra el caption esperado en el JSON — los thumbnails de baja resolución dan falsos positivos de ortografía. Solo reporta defecto de subtítulo si el texto en pantalla realmente difiere del `caption.text` esperado (o si el `caption.text` esperado en sí tiene un error, lo cual ya debería haber sido corregido en la etapa de auditoría de subtítulos, pero repórtalo igual si lo notas).
4. **El subtítulo no tapa la cara**: el bloque de texto no debe superponerse a la cara/cabeza del instructor en el frame.
5. **Sin frames negros/congelados/cortados**: la imagen no debe estar completamente negra, ni mostrar un artefacto de corte abrupto (franjas negras grandes, imagen partida a la mitad, etc.). "Congelado" no se puede confirmar con un solo frame aislado — si dudas, no lo reportes como bloqueante, repórtalo como menor si el frame se ve claramente anómalo respecto a los demás.
6. **Overlays/logo (capas futuras)**: si el frame muestra algún overlay o logo superpuesto, confirma que no tapa ni la cara ni el subtítulo. Si no hay overlays visibles en este job todavía, no aplica — no lo reportes.

### Checklist adicional por tipo de frame (`kind`)

- **`overlay`**: además del checklist general, cotejando contra el caption activo en ese `timeSeconds` (calculado igual que en el punto 3 de arriba), evalúa: (a) ¿la imagen del overlay tapa la cara del instructor? (b) ¿tapa el subtítulo? (c) ¿tapa el objeto o la acción de la que está hablando el instructor en ese momento, según el caption activo? (d) ¿está bien colocada a la izquierda de la pantalla y se ve legible al tamaño en que se renderiza (no diminuta ni cortada en el borde)? Cualquier oclusión de cara o subtítulo es `tipo: "visual"`, `severidad: "bloqueante"`.
- **`inicio`**: ¿el video arranca en contenido real — sin conteo tipo "3, 2, 1", sin claqueta, sin media palabra o gesto de "ya, ya" previo al inicio real de la explicación? Si detectas un conteo, claqueta o palabra cortada, repórtalo con `tipo: "corte"` y `severidad: "bloqueante"`.
- **`final`**: ¿el video corta limpio — sin una frase a medias, sin frame congelado, sin corte abrupto en medio de una palabra o gesto? Si el corte es a media frase o el frame se ve congelado/roto, repórtalo con `tipo: "corte"` y `severidad: "bloqueante"`.

## 3. Salida obligatoria

Escribe con Write, en `jobs/<jobId>/qa/gate2/<lessonId>.json`:

```ts
interface Gate2Verdict {
  lessonId: string;
  auditedAt: string; // ISO timestamp de cuando terminas
  verdict: "APPROVED" | "REJECTED";
  frames_revisados: number; // cuántos frames del manifest efectivamente miraste
  problemas: Array<{
    frame: string; // el 'file' del frame del manifest donde se detectó
    tipo: "subtitulo" | "visual" | "audio_sospecha" | "corte" | "otro";
    detalle: string; // descripción breve y concreta en español
    severidad: "bloqueante" | "menor";
  }>;
}
```

Reglas del veredicto:

- `verdict` es `"REJECTED"` si `problemas` tiene **al menos un** problema con `severidad: "bloqueante"`. Si solo hay problemas `"menor"` (o ninguno), `verdict` es `"APPROVED"`.
- `frames_revisados` debe ser igual a la cantidad de frames que realmente miraste con Read en el paso 2 (no inventes el número).
- Si no encontraste ningún problema, `problemas` es un array vacío `[]` y `verdict` es `"APPROVED"`.

## 4. Invariantes (no negociables)

- Nunca reportes un defecto de ortografía en un subtítulo sin haberlo cotejado contra `plan/captions/<lessonId>.json` primero (regla de costo de la sección 2.3).
- No llames a ninguna API de Anthropic ni uses tokens de facturación: todo el razonamiento y la visión los haces tú, la sesión de Claude Code, con tus herramientas normales (Read/Write).
- No modifiques `plan/captions/<lessonId>.json`, el manifest de frames, ni ningún PNG — esta etapa es de solo lectura + un único archivo de salida.
