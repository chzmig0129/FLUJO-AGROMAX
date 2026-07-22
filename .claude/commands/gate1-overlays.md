---
description: Juez de QA visual "Gate 1" de cada overlay (PNG) generado — mira el composite de cada key con visión (Read) y decide APPROVED/REJECTED por imagen, usando la suscripción de Claude Code, sin usar la API de Anthropic.
---

Job a procesar: `$ARGUMENTS` — un solo token, `<jobId>` (ej. `abc123`).

Tú (la sesión de Claude Code) ERES el juez de QA visual de la etapa "Gate 1" del diseño. No hay llamada a la API de Anthropic ni tool-runner: MIRAS cada composite con tu propia herramienta Read (tienes visión sobre imágenes JPG/PNG), razonas, y al final escribes tú mismo el veredicto con Write.

## 0. Verificación previa

Antes de nada, confirma que hay algo que auditar:

- `jobs/<jobId>/qa/gate1-chk/` debe existir y tener al menos un `.jpg`. Si no, DETENTE y reporta que falta la etapa de generación de overlays — no inventes datos ni un veredicto.

## 1. Leer las entradas

Para cada archivo `jobs/<jobId>/qa/gate1-chk/<key>.jpg` encontrado:

1. Localiza el brief de esa `key` en `jobs/<jobId>/plan/overlays/<lessonId>.json` — recorre todos los archivos de `plan/overlays/` hasta encontrar el objeto `{key, fact, prompt, aspect, ...}` cuya `key` coincida. Contrato del brief:

   ```ts
   interface OverlayBrief {
     key: string;
     fact: string; // cita VERBATIM del dato que el overlay debe representar
     prompt: string;
     aspect: string;
   }
   ```

2. Si existe, lee también `jobs/<jobId>/qa/gate1.json` de una corrida anterior (puede no existir todavía) para conocer el historial de `intentos` por key y no perder la cuenta de rechazos acumulados (ver Regla de escalada, sección 4).

## 2. Mirar cada composite

Para CADA `key` con un `.jpg` en `qa/gate1-chk/`, usa Read sobre `jobs/<jobId>/qa/gate1-chk/<key>.jpg` (composite del overlay sobre fondo gris oscuro) para VERLO, y cotéjalo contra su brief. No te saltes ninguna.

### Checklist por imagen

| # | Chequeo | Causa (`causa_categoria`) si falla |
|---|---|---|
| 1 | Ortografía letra por letra de cualquier texto en la imagen (términos en español, revisados con cuidado — no de pasada) | `ortografia` |
| 2 | El número/dato del gráfico coincide EXACTAMENTE con el `fact` del brief, citado VERBATIM. Un dato mal graficado es peor que no tener gráfico — sé estricto acá | `dato` |
| 3 | Sin elementos ajenos al tema (ejemplos reales vistos: una huella de perro dibujada sobre una jeringa, un niño humano en un tema de manejo animal — cualquier cosa que no pertenezca al brief) | `elemento_ajeno` |
| 4 | Texto legible: debe ser verde oscuro sólido o estar en una tarjeta blanca con borde verde. Texto gris flotando sobre el fondo, con bajo contraste, es RECHAZO directo | `ilegible` |
| 5 | Sin daño de flood-fill: trazos "comidos" (partes del dibujo que desaparecieron), halos de color alrededor de formas, elipses blancas sueltas donde no debería haber nada | `floodfill` |
| 6 | El overlay enseña algo nuevo — no es una simple repetición visual de lo que ya se dice en el audio/subtítulo sin aportar información | `no_ensena` |

Cualquier chequeo que falle produce `verdict: "REJECTED"` para esa key, con `causa` (descripción breve en español) y `causa_categoria` (una de las seis de la tabla). Si pasa todos los chequeos, `verdict: "APPROVED"` y no lleva `causa`/`causa_categoria`.

## 3. Salida obligatoria

Escribe con Write, en `jobs/<jobId>/qa/gate1.json`:

```ts
interface Gate1Verdict {
  auditedAt: string; // ISO timestamp de cuando terminas
  images: Array<{
    key: string;
    verdict: "APPROVED" | "REJECTED";
    causa?: string; // descripción breve y concreta en español, solo si REJECTED
    causa_categoria?: "ortografia" | "dato" | "elemento_ajeno" | "ilegible" | "floodfill" | "no_ensena"; // solo si REJECTED
    intentos?: number; // contador acumulado de rechazos por MISMA causa_categoria, incluyendo este si aplica
    escalar?: boolean; // true si esta key acumula 3 rechazos por la misma causa_categoria
    escalar_motivo?: string; // solo si escalar=true
  }>;
}
```

## 4. Regla de escalada (no negociable)

Antes de escribir el veredicto final de una key, compara con el `qa/gate1.json` de una corrida previa (si existe, leído en el paso 1.2):

- Si la key ya tenía un `intentos` acumulado para la MISMA `causa_categoria` que este rechazo, incrementa ese contador en 1 y guárdalo en `intentos` del nuevo veredicto de esa key.
- Si es la primera vez que se rechaza por esa `causa_categoria`, `intentos = 1`.
- Si esta corrida da `APPROVED`, no acarrees `intentos` de rechazos anteriores (se resetea; la key ya pasó).
- **Cuando `intentos` llega a 3 (3 rechazos consecutivos por la MISMA `causa_categoria`)**, marca `escalar: true` y `escalar_motivo` explicando qué causa se repitió. `escalar: true` significa: dejar de pedirle a este modelo que reintente la imagen y en su lugar **componer determinista (HTML→PNG)** — no seguir peleando con el modelo generativo para esa key.

## 5. Invariantes (no negociables)

- Nunca apruebes un overlay sin haber cotejado su dato numérico/textual contra el `fact` VERBATIM del brief correspondiente — no confíes en la memoria del prompt, léelo del JSON.
- No llames a ninguna API de Anthropic ni uses tokens de facturación: todo el razonamiento y la visión los haces tú, la sesión de Claude Code, con tus herramientas normales (Read/Write).
- No modifiques ningún PNG, ningún brief de `plan/overlays/`, ni el composite `.jpg` — esta etapa es de solo lectura + un único archivo de salida (`qa/gate1.json`).
