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

## basura-tipica

- Texto alucinado repetido ("todo todo", "tú tú") suele indicar transcripción basura.
- Tomas de prueba de 2-3 segundos.
- Pantallas negras.

<!-- Cómo agregar una heurística: crea una sección nueva con un ID kebab-case estable (## mi-nueva-heuristica). El agente citará esa sección por su ID en el audit. -->
