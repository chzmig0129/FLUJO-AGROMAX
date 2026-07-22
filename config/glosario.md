# Glosario del proyecto

Glosario semilla de jerga técnica del dominio (razas, patologías, anatomía y
otros términos especializados que Whisper suele transcribir mal por
pronunciación coloquial o ruido). Lo usa el comando
`.claude/commands/auditar-subtitulos.md` (etapa 12, auditoría de subtítulos)
para normalizar la grafía de los captions SIN tocar tiempos ni corregir
muletillas o tartamudeos reales.

Además de este archivo (global, versionado con el repo), cada job puede tener
su propio `jobs/<id>/plan/glosario.md` con correcciones nuevas aprendidas
durante su propia auditoría — ese archivo se lee junto con este y se
actualiza al final de cada corrida (ver el comando).

## Formato

Una tabla Markdown de 3 columnas:

```md
| incorrecto | correcto | contexto |
| --- | --- | --- |
| ejemplo mal escrito | ejemplo correcto | cuándo aplica la corrección |
```

- **incorrecto**: la grafía tal como suele aparecer en la transcripción cruda
  (Whisper), producto de la pronunciación coloquial del hablante.
- **correcto**: la grafía técnica correcta a la que debe normalizarse.
- **contexto**: pista breve de cuándo aplica (para no corregir a ciegas fuera
  de contexto — ej. una palabra parecida que en otro sentido es válida tal
  cual está).

## Tabla semilla

| incorrecto | correcto | contexto |
| --- | --- | --- |
| Lars White | Large White | raza porcina |
| York Lras | York Landrace | raza porcina |
| duro | Duroc | raza porcina (cuando se refiere a la raza, no al adjetivo "duro") |
| labre | la ubre | anatomía, glándula mamaria |
| distóxico | distócico | patología, parto complicado |
| erizipela | Erisipela | patología porcina |
| del P es | del PLE | sigla/término técnico del curso |
| testerona | testosterona | hormona |
| mamar lostro | calostro | primera leche materna |
| de peles | pellets | alimento balanceado |
