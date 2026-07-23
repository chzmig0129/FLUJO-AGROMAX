# Estilo obligatorio de los overlays (ilustraciones didácticas)

Este archivo define el `STYLE` "Draw My Life": dibujo a mano alzada estilo
whiteboard/doodle, como si el profesor lo dibujara en el pizarrón mientras
explica, con trazos de tinta negra gruesos y limpios. Es el **sufijo
obligatorio** de TODO prompt de generación de overlay de este pipeline
(etapa 8, generación de imagen): el `prompt` que escribe el brief (etapa 7,
`plan/overlays/<lessonId>.json`) describe SOLO el contenido visual concreto;
este bloque de estilo se concatena aparte, al final, cuando se arma el
prompt final que se envía al generador de imágenes.

Este reemplaza el estilo anterior (ilustración vectorial plana tipo
infografía, paleta verde/gris): ya no se usa relleno de color, paleta
vectorial ni tarjetas con borde; ahora es dibujo a mano tipo pizarrón.

## STYLE (texto exacto a concatenar)

```
Estilo: dibujo a mano alzada estilo whiteboard/doodle "Draw My Life", como
si un profesor lo dibujara en tiempo real en el pizarrón mientras explica.
Trazos de tinta NEGRA gruesos y limpios, sin relleno de color (a lo sumo un
acento ocasional en verde #16A34A para resaltar UN solo dato clave), sin
degradados, sin marco, sin sombra ni elipse de piso bajo las figuras, sobre
FONDO BLANCO LISO puro, márgenes amplios, formato cuadrado, alta
resolución. El texto que aparezca debe estar en ESPAÑOL correcto y bien
escrito, con letra de mano LEGIBLE estilo hand-lettering, en tinta negra
gruesa o dentro de un recuadro dibujado a mano. IMPORTANTE: nunca texto
gris tenue ni delgado flotando sobre el fondo, siempre trazo grueso y
legible. Vocabulario visual obligatorio: la marca de aprobación SIEMPRE se
dibuja como una marca de verificación (checkmark ✓) trazada a mano, y la
marca de rechazo SIEMPRE como una cruz (X) trazada a mano. NUNCA dibujar
animales que no sean el tema de la lección; en particular NUNCA una paloma
ni ningún ave para representar aprobación o un "visto bueno".
```

## Reglas que se desprenden de este STYLE (para quien escriba prompts)

1. **Fondo**: blanco liso puro. Esta regla se CONSERVA del estilo anterior
   por una razón técnica: el flood-fill de la etapa de recorte necesita un
   fondo blanco liso uniforme para poder quitarlo; no puede haber
   degradados, marcos, sombras ni elipses de piso bajo las figuras.
2. **Trazo**: tinta negra, gruesa y limpia, aspecto de dibujo a mano alzada
   tipo pizarrón/whiteboard ("Draw My Life"). Sin relleno de color. Único
   color permitido además del negro: un acento verde `#16A34A` ocasional,
   máximo sobre UN dato clave por ilustración, y solo si el `prompt` del
   brief lo pide explícitamente.
3. **Composición**: doodle a mano estilo whiteboard animation, márgenes
   amplios, formato cuadrado, alta resolución.
4. **Texto dentro de la imagen** (si el brief pide texto renderizado): esta
   regla se CONSERVA del estilo anterior porque, tras quitar el fondo en el
   flood-fill, un texto gris tenue o delgado se pierde o queda ilegible.
   - Español correcto y bien escrito (nunca inglés, nunca faltas).
   - Letra de mano LEGIBLE estilo hand-lettering, SIEMPRE en tinta negra
     gruesa, o bien dentro de un recuadro dibujado a mano.
   - NUNCA texto gris tenue ni delgado flotando sobre el fondo blanco.
5. **Números y datos**: se CONSERVA la regla de que deben ser grandes y
   protagonistas de la ilustración, dibujados a mano con trazo grueso.
6. **Vocabulario visual de aprobación/rechazo**: la marca de aprobación
   SIEMPRE se describe y dibuja como una marca de verificación (checkmark
   ✓) trazada a mano; la marca de rechazo SIEMPRE como una cruz (X) trazada
   a mano. Prohibición dura: NUNCA dibujar animales que no sean el tema de
   la lección; en particular NUNCA una paloma ni ningún ave para
   representar aprobación o un "visto bueno". Quien escriba el `prompt` del
   brief (etapa 7) debe evitar la palabra "palomita" (ambigua: en México
   significa checkmark, pero literalmente es un ave) y usar siempre "marca
   de verificación" o "checkmark" en su lugar.
7. Este bloque de estilo es fijo e igual para todos los overlays del
   pipeline: no se parafrasea, no se recorta, no se le agregan adjetivos
   nuevos. El `prompt` de cada brief (etapa 7) describe únicamente QUÉ se
   dibuja (figuras, textos exactos entre comillas, disposición); el CÓMO
   (estilo visual) siempre es este archivo, concatenado al final del prompt
   en la etapa de generación de imagen (etapa 8, fuera del alcance de este
   archivo).
