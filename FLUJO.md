# El flujo, explicado en cristiano

Qué hace el sistema hoy, paso a paso. Cada paso dice **qué recibe**, **qué hace**
y **qué entrega**. Sin jerga: donde hace falta un término técnico, va entre
paréntesis para que lo puedas buscar en el código.

Si lo único que querés saber es "¿qué está haciendo ahorita?", andá directo a
[¿En qué paso voy?](#en-qué-paso-voy).

---

## La idea, en una línea

**Le das un ZIP con los videos crudos de un curso. Te devuelve un video por clase, ya editado.**

```
   📦 ZIP con                                              🎬 Un video
   videos crudos  ────────► [ 10 pasos ] ────────────────►  por clase
```

Todo lo que se genera en el camino queda guardado y se puede revisar. Y algo que
no cambia nunca: **tus videos originales no se tocan**. Ni se editan, ni se
mueven, ni se borran. Solo se leen.

---

## Los 10 pasos de un vistazo

| # | Paso | Qué recibe | Qué entrega |
|---|---|---|---|
| 1 | **Abrir el paquete** | el ZIP | los videos sueltos |
| 2 | **Medir los videos** | los videos | ficha técnica de cada uno |
| 3 | **Escuchar y escribir** | los videos | todo lo hablado, con tiempos |
| 3.5 | **Sacar fotos** | los videos | fotos de muestra de cada clip |
| 4 | **Armar el curso** 🤖 | lo hablado + las fotos | qué sirve y cómo se ordena |
| 5A | **Buscar los silencios** | los clips que sí se usan | dónde nadie habla |
| 5B | **Copias parejas** | los clips que sí se usan | todos del mismo tamaño y ritmo |
| 5C | **Decidir los recortes** | lo hablado + los silencios | qué se va y qué se queda |
| 9 | **Hacer las portadas** | la estructura del curso | una portada por clase |
| 11 | **Armar el video** | copias + recortes + portadas | 🎬 **el video de cada clase** |

**Solo el paso 4 usa inteligencia artificial.** Todo lo demás son reglas fijas:
las mismas entradas siempre dan el mismo resultado. Es a propósito — decidir qué
material sirve requiere criterio; cortar un silencio de 2 segundos, no. Meter un
modelo ahí solo agregaría costo y resultados impredecibles.

Los números saltan de 5C a 9 y de 9 a 11 porque los pasos 6 a 8 y el 10
(textos en pantalla, subtítulos, música) **todavía no están hechos**. La
numeración es del plan completo, no de lo que existe hoy.

---

## Paso 1 — Abrir el paquete

**Recibe:** el ZIP que subiste.
**Entrega:** los videos sueltos en una carpeta, y una ficha del proyecto.

Se descomprime el ZIP y se le echa un primer vistazo a cada archivo: cuánto dura,
qué tamaño tiene, si trae audio. Si alguno viene raro (no es video, dura cero, no
tiene sonido) queda anotado — pero **no se descarta**: esa decisión es del paso 4.

De acá en adelante, esa carpeta de originales queda congelada.

---

## Paso 2 — Medir los videos

**Recibe:** los videos.
**Entrega:** la ficha técnica de cada uno.

Cuántos cuadros por segundo tiene, en qué formato está grabado, cuántos canales
de audio. Acá se anota cuáles son "demasiado grandes" (más de 1080p o más de 30
cuadros por segundo) — que es lo que después justifica hacerles una copia más
liviana en el paso 5B.

⏱️ Un suspiro: 80 videos en 5 segundos.

---

## Paso 3 — Escuchar y escribir

**Recibe:** los videos.
**Entrega:** todo lo que se dice, escrito, **con el tiempo exacto de cada palabra**.

Un programa de reconocimiento de voz (Whisper) escucha cada clip y escribe lo
hablado. Lo importante no es tanto el texto: son **los tiempos**. Saber que la
palabra "rumen" se dijo en el segundo 12.4 es lo que después permite cortar los
silencios sin comerse el habla.

Dos detalles que evitan problemas:

- **Cuando nadie habla, no se inventa.** Estos programas a veces "escuchan" frases
  en un clip mudo. Por eso, antes de creerle, se mide si de verdad hay voz en el
  audio. Si no la hay, el clip se marca como sin narración y esa frase inventada
  no contamina el resto.
- **Funciona en Mac y en Windows**, con el motor que corresponda a cada máquina.

⏱️ **La primera espera larga: ~1 hora para 80 clips.**

---

## Paso 3.5 — Sacar fotos

**Recibe:** los videos + lo que se escribió.
**Entrega:** fotos de muestra de cada clip.

Se sacan fotos cada tantos segundos, para que en el paso siguiente la IA pueda
**ver** el material y no solo leerlo. Si el clip tiene alguien hablando, alcanza
con unas pocas fotos. Si es un clip sin voz, se sacan más: cuando no hay palabras
que leer, lo único que se puede juzgar es la imagen.

⏱️ Menos de un minuto.

---

## Paso 4 — Armar el curso 🤖

**Recibe:** todo lo hablado + las fotos + tus notas de criterio editorial.
**Entrega:** qué material sirve, y cómo se ordena el curso.

**Este es el único paso donde trabaja la IA**, y es el que decide qué curso
existe. Corre solo, sin pedirte permiso en el camino, y hace dos cosas:

1. **Separa el material.** Cada clip queda clasificado como: *sirve para una
   clase*, *sirve de apoyo visual*, *a la basura* (tomas de prueba, repeticiones)
   o *es de otro curso* (se coló material de otra especie).
2. **Ordena el curso.** Módulos → clases → qué pedazo de qué clip va en cada una.

Si no está seguro de un clip, **puede pedir más fotos** para mirarlo mejor (con un
límite). Cada vez que lo hace queda registrado.

**Una marca que importa mucho: clase normal vs. demostración.** En una demo el
instructor está trabajando con las manos —una inseminación, un descolado— y los
silencios **son parte de lo que estás mostrando**, no tiempo muerto. A una demo no
se le recorta nada. Esa marca la pone la IA acá y la respetan todos los pasos
siguientes.

> En tu curso de OVINOS: 6 módulos, 20 clases, 2 de ellas demostraciones
> (*inseminación por laparoscopía* y *manejo de corderos recién nacidos*). De 80
> clips: 50 sirven, 18 a la basura, 7 eran de otro curso, 5 de apoyo visual.

Nada de esto se aprueba a mano. Queda un documento explicando **por qué** decidió
cada cosa, para que lo revises después si algo te suena raro.

---

## Paso 5A — Buscar los silencios

**Recibe:** los clips que alguna clase usa.
**Entrega:** el mapa de dónde nadie habla.

Se mide dónde el audio está por debajo del umbral de "alguien está hablando" por
más de medio segundo, y se calcula **cuánto duraría cada clip si le quitaras esos
huecos**. El número sale de la medición real, no de una estimación: si un clip no
tiene silencios, se reporta tal cual, sin recorte.

Las demostraciones se miden igual (sirve para revisar), pero quedan marcadas como
intocables. Y con criterio precavido: si un clip aparece aunque sea en **una**
clase de demostración, se protege entero.

⏱️ En OVINOS: ~40 minutos para 55 clips.

---

## Paso 5B — Copias parejas

**Recibe:** los clips que alguna clase usa.
**Entrega:** una copia de cada uno, todas del mismo tamaño y ritmo.

Este es el paso que más tarda, y el más fácil de malinterpretar viendo la
computadora al 100%. Lo que hace es simple: **tus videos vienen dispares** —
algunos en 4K, otros a 60 cuadros por segundo, otros del celular. Acá se hace una
copia de cada uno con **exactamente las mismas características**: 1080p, 30
cuadros por segundo, siempre.

¿Para qué tanto? Porque cuando todos los videos van al mismo ritmo, "el cuadro
número 900" significa *siempre* "el segundo 30". Eso es lo que permite cortar y
pegar pedazos sin que la imagen y el sonido se desfasen. Sin este paso, los
cortes se irían corriendo de a milésimas hasta que el audio no coincide con la
boca.

*(En el código y en el resto de la documentación estas copias se llaman
**proxies**, y hacerlas se dice **transcodificar**.)*

Tres cosas a favor:

- Trabaja en varios videos a la vez, según los núcleos de tu máquina.
- Escribe en un archivo temporal y recién al terminar lo renombra: **nunca queda
  una copia a medias** que después parezca buena.
- Si volvés a correrlo, se saltea las que ya están hechas.

⏱️ **La segunda espera larga, y la más pesada.** Con ~55 clips de material 4K,
contá con un buen rato de CPU al máximo. Vas a ver el avance como X/N en la
pantalla del proyecto.

---

## Paso 5C — Decidir los recortes

**Recibe:** lo hablado + los silencios + la estructura del curso.
**Entrega:** un archivo por clase con qué se va y qué se queda.

Acá se decide **qué se va a quitar**, pero todavía no se toca ningún video: son
puras cuentas sobre los tiempos de las palabras. Por eso es la parte más fácil de
revisar del sistema — cada recorte propuesto se puede explicar leyendo el archivo.

La regla: si entre dos palabras pasa más de 0.6 segundos, ese hueco es candidato a
recorte — pero **se le deja casi un quinto de segundo de aire a cada lado**, para
no comerse jamás el final de una palabra ni el arranque de la siguiente. Cuando
las cuentas no dan exactas, siempre se redondea hacia dejar *más* aire, nunca
menos. Los recortes ridículamente cortos (menos de 3 cuadros) se descartan: no
vale la pena.

Cada recorte además se cruza contra el paso 5A: si ahí también se midió silencio,
queda doblemente confirmado.

El archivo guarda las dos caras de la misma moneda:

- **lo que se va** (para que lo puedas auditar),
- **lo que se queda** (esto es lo que arma el video final).

Y las dos listas encajan perfecto: cubren la clase entera, sin huecos ni pedazos
repetidos. Las demostraciones salen sin ningún recorte, enteras.

⏱️ Segundos.

---

## Paso 9 — Hacer las portadas

**Recibe:** la estructura del curso.
**Entrega:** una portada animada de 5 segundos por clase.

Los textos salen solos de la estructura: título de la clase, `MÓDULO 2 · CLASE 3`,
nombre del curso y el tema. Colores de la plataforma (verde) y la tipografía de la
marca, incluida dentro del proyecto para que no dependa de internet a la hora de
generar.

Es totalmente predecible: la misma clase genera siempre la misma portada, idéntica.

---

## Paso 11 — Armar el video

**Recibe:** las copias parejas + la lista de qué se queda + las portadas.
**Entrega:** 🎬 **el video terminado de cada clase**.

El momento en que por fin sale video. Por cada clase: la portada al inicio, y
después **solo los pedazos que se quedan**, uno tras otro. *Eso* es el corte de
silencios — acá no se decide nada, se ejecuta lo que el paso 5C ya calculó.

Tres cosas que vale la pena que sepas:

- **La herramienta de armado es reemplazable.** Hoy arma un programa que corre
  solo en el servidor, sin ventanas ni interfaz. Está construido de forma tal que
  mañana se puede enchufar otra herramienta (para retocar a mano) sin tocar el
  resto del sistema.
- **"Terminado" se comprueba, no se supone.** Un video cortado a la mitad también
  existe en el disco y también pesa. Por eso, al terminar, se le cuentan los
  cuadros uno por uno y se comparan con los que debería tener. Si no coinciden, no
  se acepta. Solo un video que pasó esa revisión se puede reproducir desde la
  pantalla — un archivo incompleto ni siquiera aparece.
- **Volver a armar es barato.** Si una clase ya está lista y nada cambió, se
  saltea. Si tocaste sus recortes, se rehace esa clase sola. Nunca se rehacen las
  copias parejas ni se recalculan los cortes.

---

## ¿En qué paso voy?

El estado del proyecto te dice exactamente dónde está. Los que están en
**negrita** son de descanso: el sistema terminó y **te espera a vos** para
apretar el siguiente botón.

| Estado | Qué está pasando | Qué sigue |
|---|---|---|
| `ingested` | ZIP abierto | sigue solo |
| `probing` / `probed` | midiendo los videos | sigue solo |
| `transcribing` | ⏳ escuchando y escribiendo (~1 h) | sigue solo |
| `sampling` / **`sampled`** | fotos listas | botón *Generar estructura* |
| `planning` | 🤖 la IA está armando el curso | — |
| **`planned`** | ya hay curso, falta cortar | botón *Preparar corte* |
| `preparing` | ⏳ silencios + copias + recortes | — |
| **`prepared`** | recortes decididos, todavía sin video | botón *Ensamblar clases* |
| `assembling` | ⏳ portadas + armado | — |
| `assembled` | 🎬 **hay videos para ver** | — |
| `error` | algo falló; el mensaje dice qué | se reintenta solo ese paso |

La pantalla del proyecto se actualiza sola cada 2 segundos y muestra el avance
detallado (X de N) mientras corre lo largo: la transcripción, las copias parejas
y el armado.

---

## Volver atrás sin repetir lo caro

Cada paso tiene su propio botón, y **ninguno rehace lo anterior**. Esto es lo que
hace llevadero corregir cosas en un curso de 80 clips:

| Si querés rehacer… | Botón | NO se repite |
|---|---|---|
| Todo desde el principio | *Re-transcribir* | abrir el ZIP |
| Solo las fotos | *Re-muestrear frames* | la transcripción (1 h) |
| Solo el armado del curso | *Re-generar estructura* | transcripción y fotos |
| Solo el corte | *Re-preparar corte* | la IA y la transcripción |
| Solo el video final | *Ensamblar clases* | copias y recortes |

El caso típico: ves que una clase quedó marcada como normal cuando en realidad es
una demostración → lo corregís a mano → *Re-preparar corte* → *Ensamblar clases*.
La IA no vuelve a correr y no esperás la hora de transcripción de nuevo.

---

## Dónde queda guardado cada cosa

```
jobs/<id>/
  job.json                    en qué paso va el proyecto
  source/                     🔒 tus videos originales — NUNCA se tocan
  probe/
    media.json                ficha técnica de cada video     [paso 2]
    silence.json              dónde nadie habla               [paso 5A]
  transcripts/                todo lo hablado, con tiempos    [paso 3]
  frames/                     fotos de muestra                [paso 3.5]
  plan/
    verdicts.json             qué sirve y qué no              [paso 4] 🤖
    structure.json            módulos, clases y sus pedazos   [paso 4] 🤖
    decisiones.md             por qué la IA decidió eso
    cuts/<clase>.json         qué se va y qué se queda        [paso 5C]
  assets/
    proxies/<clip>.mp4        las copias parejas              [paso 5B]
    intros/<clase>.mp4        las portadas                    [paso 9]
  render/
    <clase>.mp4               🎬 el resultado                 [paso 11]
    <clase>.json              el comprobante de que está completo
  progress/                   el avance en vivo de lo que tarda
```

---

## Lo que todavía falta construir

- **Textos en pantalla** (pasos 6 a 8): títulos, nombres, datos sobre el video.
- **Subtítulos** (paso 10): los tiempos de cada palabra ya existen desde el paso
  3; falta dibujarlos.
- **Música y mezcla de audio.**
- **El modo de retoque manual**: el enchufe ya está listo, falta la herramienta.

Todo eso va **encima** de lo que ya funciona: el paso 11 entrega el video base
sobre el que después se pintan las capas.

---

## Glosario mínimo

Por si te cruzás con estas palabras en el código o en el [README](README.md):

| Palabra técnica | En cristiano |
|---|---|
| **proxy** | la copia pareja de un video (1080p, 30 cuadros) |
| **transcodificar** | hacer esa copia |
| **frame** | un cuadro de video (hay 30 por segundo) |
| **keep / cuts** | lo que se queda / lo que se va de cada clase |
| **kind: demo** | clase de demostración: no se le recorta nada |
| **stage / etapa** | cada uno de los pasos de este documento |
| **job** | un proyecto: un ZIP y todo lo que se generó a partir de él |
| **sidecar** | el archivito que certifica que un video quedó completo |
| **ensamblaje** | pegar portada + pedazos para formar el video final |
