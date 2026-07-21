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

## basura-tipica

- Texto alucinado repetido ("todo todo", "tú tú") suele indicar transcripción basura.
- Tomas de prueba de 2-3 segundos.
- Pantallas negras.

<!-- Cómo agregar una heurística: crea una sección nueva con un ID kebab-case estable (## mi-nueva-heuristica). El agente citará esa sección por su ID en el audit. -->
