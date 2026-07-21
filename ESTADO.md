# Qué está construido y qué falta

Comparación entre el diseño completo del pipeline (16 etapas) y lo que existe
hoy en este repo. Verificado contra el código, no de memoria.

**Resumen: 10 de 16 etapas construidas.** El camino "video crudo → video cortado
con portada" está completo y probado end to end. Lo que falta es todo lo que va
*encima* del video (textos, subtítulos) y todo el sistema de control de calidad
automático.

---

## El tablero

| # | Etapa del diseño | Estado | Dónde vive |
|---|---|---|---|
| 1 | Ingest | ✅ **completa** | `zip.ts`, `api/ingest` |
| 2 | Probe | ✅ **completa** | `probe-stage.ts` |
| 3 | Transcribe | ✅ **completa** | `transcribe/` |
| 4 | Medir silencio | ✅ **completa** | `silence-stage.ts` |
| 5 | Proxies | ✅ **completa** | `proxy-stage.ts` |
| 6 | Estructura del curso 🧠 | ⚠️ **casi** — falta el gate humano | `plan/agent.ts` |
| 7 | Conceptos → briefs de overlay | ❌ **no existe** | — |
| 8 | Generar ilustraciones + Gate 1 | ❌ **no existe** | — |
| 9 | Intros | ✅ **completa** | `remotion/Intro.tsx` |
| 10 | Cálculo de cortes | ✅ **completa** | `cuts-stage.ts` |
| 11 | Ensamblaje | ⚠️ **parcial** — video sí, capas no | `assembly/`, `remotion/Lesson.tsx` |
| 12 | Auditoría de subtítulos | ❌ **no existe** | — |
| 13 | Export | ✅ **completa** (y más estricta que el diseño) | `assembly/verify.ts` |
| 14 | Gate 2 — QA visual por clase | ❌ **no existe** | — |
| 15 | Gate 3 — revisión por módulo | ❌ **no existe** | — |
| 16 | Empaquetado y entrega | ❌ **no existe** | — |

---

## Lo que está completo (y cómo se compara con el diseño)

**Etapas 1-5 y 10 — la preparación entera.** Es exactamente lo que el diseño
proponía construir primero, y está terminado:

- El silencio se **mide**, nunca se asume (principio de diseño #1). Tu curso de
  OVINOS lo confirmó otra vez: audio de campo, poco que recortar.
- Los clips de demostración quedan exentos de recorte, con criterio conservador:
  si un clip aparece en **alguna** clase demo, se protege entero.
- Los cortes salen de los huecos entre segmentos de Whisper con 0.18 s de aire —
  los mismos números del diseño — y por construcción **no pueden caer a mitad de
  palabra**.
- Todo es artefacto en disco con su manifiesto JSON (principio #2).

**Etapa 9 — intros.** Remotion, determinista, sin modelo. Como el diseño.

**Etapa 13 — export.** Acá el repo es **más estricto que el diseño**: no solo se
verifica que el export llegó a "completado", se le **cuentan los cuadros al
archivo** y se comparan contra los esperados antes de aceptarlo. El diseño
advertía del archivo parcial como fallo silencioso clásico; la implementación lo
cierra del todo.

---

## Las tres brechas grandes

### 1. Las capas encima del video (etapas 7, 8, 12)

Hoy el video sale **limpio**: portada + material cortado. Sin overlays didácticos,
sin subtítulos, sin logo. Todo el bloque de valor didáctico del diseño —los
gráficos que enseñan lo que la narración no muestra, los ~440 subtítulos
auditados— **no está construido**.

Lo que falta concretamente:

- **Etapa 7**: leer la transcripción de cada clase y decidir qué momentos merecen
  un gráfico (los datos, reglas y comparaciones — no repetir lo que ya se ve).
- **Etapa 8**: generarlos, quitarles el fondo, e inspeccionar cada uno antes de
  usarlo. Con la regla de escalada: 3 fallas por la misma causa ⇒ componerlo de
  forma determinista en vez de seguir peleando con el modelo.
- **Subtítulos**: ni generarlos ni auditarlos. Los tiempos por palabra ya existen
  desde la etapa 3 — la materia prima está, falta dibujarla.
- **Glosario del proyecto**: el diseño lo pide desde la etapa 3 y lo reusa en la
  auditoría de subtítulos. No existe. Es lo que corrige `Lars White` → Large
  White, `duro` → Duroc.

El ensamblaje ya tiene el lugar donde enchufarlas: `remotion/Lesson.tsx` compone
la clase por capas, agregar una pista de overlays o de subtítulos encima es
aditivo, no una reescritura.

### 2. El control de calidad automático (Gates 1, 2, 3)

**Cero de los tres gates existe.** Hoy la única verificación es técnica (¿el
archivo quedó completo?), no de contenido: nadie mira si un subtítulo está mal
escrito, si un gráfico tapa la cara del instructor, o si las clases de un módulo
tienen sentido en secuencia.

Esto es lo que el diseño llama "las corridas desatendidas confiables". Sin gates,
alguien tiene que ver los 8 videos.

El hallazgo del diseño que más pesa acá: **los cuadros al azar son los que
encuentran lo que nadie anticipó** — un cuadro random en el segundo 211.7 destapó
17 subtítulos mal escritos que ninguna revisión dirigida iba a encontrar.

### 3. La aprobación humana de la estructura (etapa 6)

El planificador está completo y usa el modelo correcto (`claude-opus-4-8`,
adaptive thinking, effort high, con la transcripción cacheada). **Lo que falta es
el punto de intervención**: hoy la etapa 4 corre y lo que produce se usa tal cual;
la UI lo muestra como auditoría de **solo lectura**.

El diseño identifica esto como uno de los dos únicos lugares donde un humano
debería meterse, y por una razón económica clara: **reordenar clases en una tabla
es gratis; reordenarlas después de renderizar 8 videos es carísimo**.

Hoy tu única salida es editar `structure.json` a mano y re-preparar. Funciona,
pero no es una función del producto.

---

## Las brechas chicas

| Falta | Impacto |
|---|---|
| **`order.json` al subir** (orden y títulos que da el usuario) | El planificador adivina la secuencia por nombre de archivo |
| **Checksums en la ingesta** | Sin deduplicación ni cache keys entre corridas |
| **B-roll dentro de una clase** | La estructura detecta clips de apoyo pero no tiene dónde declarar "insertá este a los 2:00, mudo". El ensamblaje solo concatena los segmentos principales |
| **Empaquetado final (etapa 16)** | No hay carpeta de entrega con `NOTAS.md` por clase. Los videos quedan en `render/` con nombres internos (`lesson-1.mp4`), no `M1C1_Nombre.mp4` |
| **Paralelismo entre etapas** | Transcripción y proxies podrían correr juntos (no dependen entre sí) y hoy van uno detrás del otro. En OVINOS eso son ~1 h + ~1.5 h en serie que podrían solaparse |

---

## Una desviación deliberada del diseño (y creo que correcta)

El diseño recomienda: **ship con Palmier primero**, agregar el backend headless
cuando la concurrencia sea el cuello de botella.

Se hizo al revés: **Remotion headless está construido y funcionando; Palmier es el
stub.** Los dos viven detrás de la misma interfaz (`ASSEMBLY_BACKEND`), que es la
arquitectura que el diseño pedía.

Por qué me parece la decisión correcta para este caso: el diseño justifica
empezar por Palmier porque reconstruir captions con karaoke, keyframes y export
"es semanas de trabajo". Pero **esta versión todavía no tiene captions ni
overlays** — el ensamblaje que hacía falta era concatenar tramos con una portada,
que en Remotion fueron horas, no semanas. Y a cambio el sistema arranca sin el
techo duro de Palmier: **una app de escritorio, un job a la vez, en toda la
máquina**.

El costo de haberlo hecho así aparece cuando lleguen los overlays y los
subtítulos: esa parte sí hay que construirla en Remotion en vez de heredarla de
un NLE. Palmier sigue teniendo su lugar reservado para el modo "abrí el curso en
un editor de verdad y retocalo".

---

## Qué sigue, en orden de valor

1. **El gate humano de la estructura.** Es lo más barato de construir (una tabla
   con Aprobar / Editar sobre datos que ya existen) y evita el error más caro del
   pipeline: descubrir que el curso está mal ordenado *después* de renderizar.
2. **Subtítulos + su auditoría** (etapas 12 y parte de la 11). Los tiempos por
   palabra ya están desde la etapa 3; es la capa de mayor valor didáctico por
   unidad de esfuerzo, y el glosario que produce mejora todo lo demás.
3. **Gate 2** (QA visual por clase, con cuadros al azar). Es lo que convierte una
   corrida desatendida en algo en lo que confiás sin ver los 8 videos.
4. **Overlays** (etapas 7 y 8 + Gate 1). El bloque más grande y el que más
   iteración necesita — conviene atacarlo cuando los gates ya existan, porque los
   overlays son justamente lo que más rechazos genera.
5. **Empaquetado** (etapa 16). Rápido, y es lo que hace auditable el resultado
   seis meses después.
