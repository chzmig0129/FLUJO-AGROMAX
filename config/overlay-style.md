# Estilo obligatorio de los overlays (ilustraciones didácticas)

Este archivo porta, sin reinterpretarlo, el `STYLE` que ya se usaba en
`/Users/chavez/Documents/AGROMAX/EDITOR/overlays/gen_ilustraciones.py`
(líneas 15-21) para generar las ilustraciones vectoriales del curso vía
ChatGPT/DALL·E. Es el **sufijo obligatorio** de TODO prompt de generación de
overlay de este pipeline (etapa 8, generación de imagen): el `prompt` que
escribe el brief (etapa 7, `plan/overlays/<lessonId>.json`) describe SOLO el
contenido visual concreto; este bloque de estilo se concatena aparte, al
final, cuando se arma el prompt final que se envía al generador de imágenes.

## STYLE (texto exacto a concatenar)

```
Estilo: ilustración vectorial plana moderna, limpia, tipo infografía
educativa profesional, paleta verde (#16A34A) y gris oscuro sobre FONDO
BLANCO LISO puro, sin degradados de fondo, sin marco, sin sombra ni elipse
de piso bajo las figuras, márgenes amplios, alta resolución, cuadrada. El
texto que aparezca debe estar en ESPAÑOL correcto y bien escrito.
IMPORTANTE: todo el texto debe ir en VERDE OSCURO fuerte, o bien en gris
oscuro pero SIEMPRE dentro de una tarjeta blanca con borde verde. Nunca
texto gris flotando sobre el fondo blanco.
```

## Reglas que se desprenden de este STYLE (para quien escriba prompts)

1. **Fondo**: blanco liso puro. Nada de degradados, marcos, sombras ni
   elipses de piso bajo las figuras.
2. **Paleta**: verde `#16A34A` y gris oscuro. Sin otros colores salvo que el
   `prompt` del brief lo pida explícitamente para un ícono puntual (ej. un
   ícono de alerta).
3. **Composición**: ilustración vectorial plana tipo infografía educativa,
   márgenes amplios, formato cuadrado, alta resolución.
4. **Texto dentro de la imagen** (si el brief pide texto renderizado):
   - Español correcto y bien escrito (nunca inglés, nunca faltas).
   - SIEMPRE en verde oscuro fuerte, o en gris oscuro DENTRO de una tarjeta
     blanca con borde verde.
   - NUNCA texto gris flotando directamente sobre el fondo blanco sin
     tarjeta.
5. Este bloque de estilo es fijo e igual para todos los overlays del
   pipeline: no se parafrasea, no se recorta, no se le agregan adjetivos
   nuevos. El `prompt` de cada brief (etapa 7) describe únicamente QUÉ se
   dibuja (figuras, textos exactos entre comillas, disposición); el CÓMO
   (estilo visual) siempre es este archivo, concatenado al final del prompt
   en la etapa de generación de imagen (etapa 8, fuera del alcance de este
   archivo).
