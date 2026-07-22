<!-- Estas son heurísticas para los cursos actuales de AgroMax. Edítalas o reemplázalas para otros tipos de curso. El agente las trata como pistas, no como reglas absolutas. -->

## separacion-de-cursos

- La especie separa cursos: borregos/ovejas vs cerdos/marranas son cursos distintos.
- Confirmar la especie con los frames extraídos cuando el audio sea ambiguo.

## aperturas

- Frases como "Hola amigos/alumnos de Agromax, en esta ocasión vamos a hablar de..." marcan el inicio de una clase o módulo.

## nombres-de-modulos

- El instructor suele nombrar los módulos explícitamente (por ejemplo, "capítulo de nutrición/sanidad/reproducción").
- Preferir esos nombres dichos por el instructor sobre nombres inferidos.

## orden-declarado

- El instructor a veces declara el orden hablando ("habíamos platicado antes", "más adelante", "en la clase pasada").
- Usar esas referencias para ordenar módulos y temas cuando estén disponibles.

## retakes

- Un retake es la misma toma repetida, a veces terminando en "perdón, otra vez".
- Preferir la última versión completa de una toma repetida.

## uso-de-broll

- El B-roll con veredicto "broll" (imagen útil de apoyo visual, sin audio relevante) no debe quedarse fuera de la estructura del curso.
- Debe ASIGNARSE como segment de apoyo visual dentro de la lección/módulo temáticamente afín, al final de esa lección.
- El topic de ese segment debe llevar el prefijo "B-roll: <qué se ve>" (por ejemplo, "B-roll: aplicación de anestesia laparoscópica en oveja").
- Decidir la lección afín usando el contexto: transcript/resumen del clip, decisiones previas y, si hace falta, los frames.
- Solo el B-roll descartado (veredicto distinto de "broll" con decisión de descarte, basura, retake fallido, etc.) queda fuera de structure.json.

## arranques-limpios

- Al definir el `start` de cada segment (etapa 4), examina la transcripción del inicio del clip: conteos del instructor ("3, 2, 1", "uno, dos, tres"), claquetas verbales, preguntas de grabación ("¿ya está grabando?", "¿ya?") y respiraciones/falsos inicios repetidos NO son contenido del tema — hay que saltarlos, no incluirlos en el segment.
- El conteo transcrito por Whisper es la evidencia: usa el timestamp de la primera palabra de CONTENIDO real (la primera frase del tema, no el conteo) menos ~0.3s de aire como `start`.
- Ejemplo real (curso OVINOS): la transcripción arranca "2, 1, hola..." → el `start` cae en "hola" (o en la primera frase del tema), nunca en "2" ni "1".
- Simétricamente, al final del segment, corta despedidas de toma si existen ("corte", "ya quedó").

## basura-tipica

- Texto alucinado repetido ("todo todo", "tú tú") suele indicar transcripción basura.
- Tomas de prueba de 2-3 segundos.
- Pantallas negras.

<!-- Cómo agregar una heurística: crea una sección nueva con un ID kebab-case estable (## mi-nueva-heuristica). El agente citará esa sección por su ID en el audit. -->
