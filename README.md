# Tora Video Engine

Generador declarativo de videos programáticos basado en [Remotion](https://www.remotion.dev/) para crear contenido corto protagonizado por personajes persistentes.

Tora Video Engine busca transformar historias descritas en YAML o JSON en videos animados reutilizando personajes, poses, fondos, componentes visuales, animaciones y estructuras narrativas.

> Status: experimental. El proyecto está en una etapa inicial de diseño y construcción del renderer.

## Idea

La meta es poder pasar de una historia como esta:

~~~yaml
title: "Tora hace deploy un viernes"
format: vertical

scenes:
  - type: intro
    character: tora
    pose: formal
    text: "Tora tiene una regla."

  - type: statement
    character: tora
    pose: serious
    text: "Los viernes no se hace deploy."

  - type: dialogue
    character: tora
    pose: confused
    text: "Pero es solo un cambio pequeño..."

  - type: chaos
    character: tora
    pose: panic
    background: server-room
    effect: alarm
    text: "Production is down."

  - type: punchline
    character: tora
    pose: coffee
    text: "Era un cambio pequeño."
~~~

a un archivo de video:

~~~text
output/tora-deploy-friday.mp4
~~~

sin editar manualmente una timeline ni escribir un componente React nuevo para cada video.

## Objetivo

El proyecto pretende construir un pequeño motor declarativo de creación de contenido.

En lugar de implementar cada video directamente con Remotion, el video se describe como datos:

~~~text
Story
  ↓
Validation
  ↓
Scene resolver
  ↓
Assets + animations + effects
  ↓
Remotion
  ↓
MP4
~~~

Remotion se encarga del rendering y de la timeline.

Tora Video Engine abstrae progresivamente:

- personajes y poses;
- fondos;
- props;
- texto y captions;
- transiciones;
- movimientos y microanimaciones;
- efectos visuales;
- música y sonido;
- duración de escenas;
- estructura narrativa.

## Principios de diseño

### Declarative over imperative

Los videos deberían poder crearse modificando datos, no escribiendo componentes React específicos para cada pieza.

### Deterministic rendering

Una misma especificación, con los mismos assets y configuración, debería producir el mismo video.

### Reusable assets

Personajes, fondos, props y efectos deben reutilizarse para mantener consistencia visual.

### Small composable primitives

Scenes, animations, effects y components deben ser pequeños y combinables.

### AI is optional

El renderer debe funcionar completamente sin IA.

La IA es una capa opcional para generar historias, decidir recursos visuales o ayudar a construir una especificación válida.

## Story format

Una historia contiene configuración global y una colección ordenada de escenas.

~~~yaml
title: "Tora programa en producción"
format: vertical
fps: 30
music: suspicious

scenes:
  - type: intro
    character: tora
    pose: coding
    background: office
    text: "Solo voy a cambiar una línea."
    duration: 3

  - type: reaction
    character: tora
    pose: confused
    background: office
    animation: slowZoom
    text: "Hmm."
    duration: 2

  - type: chaos
    character: tora
    pose: panic
    background: server-room
    effect: alarm
    text: "Hmmmmmm."
    duration: 4

  - type: punchline
    character: tora
    pose: coffee
    background: office
    text: "Rollback."
    duration: 3
~~~

El formato definitivo evolucionará junto con el schema y el MVP.

## Scenes

Las escenas son primitivas narrativas reutilizables.

Tipos contemplados inicialmente:

~~~text
IntroScene
DialogueScene
StatementScene
ReactionScene
ChaosScene
PunchlineScene
OutroScene
~~~

Cada tipo de escena controla su propio layout y animaciones.

Conceptualmente:

~~~tsx
switch (scene.type) {
  case "intro":
    return <IntroScene {...scene} />;

  case "dialogue":
    return <DialogueScene {...scene} />;

  case "reaction":
    return <ReactionScene {...scene} />;

  case "punchline":
    return <PunchlineScene {...scene} />;
}
~~~

La intención es que crear un video nuevo normalmente implique crear un nuevo archivo de historia, no un nuevo componente.

## Characters

Los personajes se modelan como colecciones de poses y metadata.

El primer personaje será **Tora**.

~~~text
assets/
└── characters/
    └── tora/
        ├── neutral.png
        ├── formal.png
        ├── happy.png
        ├── angry.png
        ├── confused.png
        ├── panic.png
        ├── reading.png
        ├── coding.png
        └── coffee.png
~~~

Una escena puede seleccionar una pose:

~~~yaml
- type: reaction
  character: tora
  pose: confused
  text: "Hmm..."
~~~

Internamente, el renderer resolvería el personaje y su asset correspondiente.

~~~tsx
<Character name="tora" pose="confused" />
~~~

### Character packs

A futuro, el engine no debería depender directamente de Tora.

Una posible estructura:

~~~text
characters/
├── tora/
│   ├── manifest.yaml
│   └── poses/
│
└── another-character/
    ├── manifest.yaml
    └── poses/
~~~

Ejemplo de manifiesto:

~~~yaml
name: tora
defaultPose: neutral

poses:
  neutral: poses/neutral.png
  happy: poses/happy.png
  confused: poses/confused.png
  coding: poses/coding.png
  panic: poses/panic.png
~~~

Esto convertiría a Tora en un character pack sobre un motor genérico.

## Backgrounds

Los fondos también son recursos reutilizables.

~~~text
assets/
└── backgrounds/
    ├── library.png
    ├── office.png
    ├── desk.png
    ├── coffee-shop.png
    ├── server-room.png
    ├── kitchen.png
    ├── space.png
    └── black.png
~~~

Uso:

~~~yaml
background: server-room
~~~

## Props

Los personajes pueden combinarse con objetos adicionales.

~~~text
assets/
└── props/
    ├── coffee.png
    ├── laptop.png
    ├── book.png
    ├── glasses.png
    └── crown.png
~~~

Ejemplo:

~~~yaml
- type: dialogue
  character: tora
  pose: coding
  props:
    - laptop
    - coffee
~~~

## Animations

Las animaciones deberían ser primitivas reutilizables calculadas a partir del frame actual de Remotion.

Ejemplos:

~~~text
fadeIn
fadeOut
float
bounce
shake
slowZoom
slideIn
~~~

Uso:

~~~yaml
animation: slowZoom
~~~

Una ilustración estática puede adquirir movimiento mediante transformaciones simples:

~~~tsx
transform: `
  translateY(${float}px)
  rotate(${rotation}deg)
  scale(${zoom})
`
~~~

La intención no es implementar animación tradicional completa, sino dar vida a assets estáticos mediante movimiento de cámara, entrada/salida y microanimaciones.

## Effects

Los efectos visuales también pueden ser reutilizables.

~~~text
effects/
├── alarm
├── rain
├── snow
├── sparkles
├── fire
├── stars
└── code
~~~

Ejemplo:

~~~yaml
- type: chaos
  character: tora
  pose: panic
  background: server-room
  effect: alarm
  text: "Production is down."
~~~

## Text

El texto es uno de los elementos principales del sistema.

Componentes posibles:

~~~text
Caption
BigCaption
SpeechBubble
Narration
Title
Subtitle
~~~

Ejemplo:

~~~yaml
textStyle: speech-bubble
text: "¿Pero quién aprobó este pull request?"
~~~

o:

~~~yaml
textStyle: big-caption
text: "TORA NO TIENE NPI"
~~~

Los componentes de texto pueden controlar automáticamente:

- entrada y salida;
- escala;
- posición;
- énfasis;
- wrapping;
- aparición palabra por palabra;
- sincronización futura con audio.

## Validation

Las historias deberían validarse antes de llegar a Remotion.

Una opción es usar Zod:

~~~ts
const SceneSchema = z.object({
  type: z.enum([
    "intro",
    "dialogue",
    "statement",
    "reaction",
    "chaos",
    "punchline",
    "outro",
  ]),

  character: z.string().default("tora"),
  pose: z.string().optional(),
  background: z.string().optional(),
  text: z.string(),
  duration: z.number().positive().optional(),
  animation: z.string().optional(),
  effect: z.string().optional(),
});
~~~

La validación debería detectar errores de configuración antes de iniciar un render costoso.

## Video formats

El MVP apunta inicialmente a video vertical:

~~~text
1080 × 1920
30 FPS
H.264
~~~

Adecuado para:

- Instagram Reels;
- TikTok;
- YouTube Shorts.

Más adelante podrían añadirse otros formatos:

~~~text
vertical     1080 × 1920
square       1080 × 1080
landscape    1920 × 1080
~~~

## Rendering

La interfaz concreta se implementará durante el MVP.

La experiencia objetivo durante desarrollo es similar a:

~~~bash
npm run dev
~~~

para abrir Remotion Studio.

Y para renderizar una historia:

~~~bash
npm run video -- stories/friday-deploy.yaml
~~~

con un resultado como:

~~~text
output/friday-deploy.mp4
~~~

A futuro, el proyecto podría exponer una CLI dedicada:

~~~bash
tora render stories/friday-deploy.yaml
tora preview stories/friday-deploy.yaml
tora validate stories/friday-deploy.yaml
tora list poses
tora list backgrounds
~~~

Ejemplo:

~~~bash
tora render stories/kubernetes.yaml   --output output/kubernetes.mp4
~~~

## Narrative templates

Además de tipos de escena, el sistema puede incorporar estructuras narrativas completas.

### Meme

~~~text
setup
setup
punchline
~~~

### Educational

~~~text
hook
problem
explanation
example
summary
~~~

### Story

~~~text
intro
conflict
escalation
resolution
punchline
~~~

### Reaction

~~~text
context
reaction
escalation
punchline
~~~

Esto permitiría mantener estructuras consistentes incluso si las historias se generan automáticamente.

## AI-generated stories

Una futura capa de IA podría convertir prompts naturales en historias declarativas.

Input:

~~~text
Tora explica por qué no se debe hacer deploy un viernes.
~~~

Output:

~~~yaml
title: "Deploy Friday"

scenes:
  - type: intro
    character: tora
    pose: formal
    text: "Tora tiene una regla."

  - type: statement
    character: tora
    pose: serious
    text: "Los viernes no se hace deploy."

  - type: dialogue
    character: tora
    pose: confused
    text: "Pero es un cambio pequeño..."

  - type: chaos
    character: tora
    pose: panic
    background: server-room
    effect: alarm
    text: "Production is down."

  - type: punchline
    character: tora
    pose: coffee
    text: "Era un cambio pequeño."
~~~

El modelo no renderiza el video directamente. Genera una especificación declarativa que el engine puede validar y renderizar de forma determinista.

~~~text
Prompt
  ↓
LLM
  ↓
Story
  ↓
Validation
  ↓
Tora Video Engine
  ↓
Remotion
  ↓
MP4
~~~

## Writer / Director architecture

Una posible evolución es separar generación narrativa y dirección visual.

### Writer

Produce únicamente la secuencia narrativa.

~~~json
{
  "narrative": [
    "Tora recibe un ticket sencillo.",
    "Lo empieza a investigar.",
    "Descubre 14 microservicios.",
    "Tora abandona la informática."
  ]
}
~~~

### Director

Convierte cada momento narrativo en instrucciones visuales.

~~~json
{
  "type": "reaction",
  "character": "tora",
  "pose": "panic",
  "background": "server-room",
  "animation": "slowZoom",
  "caption": "14 microservicios.",
  "sound": "dramatic-hit"
}
~~~

Pipeline:

~~~text
Prompt
  ↓
Writer
  ↓
Narrative
  ↓
Director
  ↓
Story specification
  ↓
Renderer
~~~

Separar Writer y Director permitiría cambiar el estilo visual sin modificar la lógica narrativa.

## Text-to-Speech

Otra extensión posible es generar narración mediante TTS.

~~~yaml
- type: narration
  voice: tora
  text: "Hoy vamos a hablar de microservicios."
~~~

El pipeline podría generar audio por escena y utilizar su duración para calcular automáticamente la duración visual.

~~~text
Story
  ↓
TTS
  ↓
Audio metadata
  ↓
Scene duration
  ↓
Remotion
~~~

Esto también permitiría generar subtítulos sincronizados palabra por palabra.

## Proposed project structure

Una estructura posible para las primeras fases:

~~~text
tora-video-engine/
├── assets/
│   ├── characters/
│   │   └── tora/
│   ├── backgrounds/
│   ├── props/
│   ├── sounds/
│   ├── music/
│   └── fonts/
│
├── stories/
│   ├── kubernetes.yaml
│   └── friday-deploy.yaml
│
├── src/
│   ├── components/
│   │   ├── Character.tsx
│   │   ├── Background.tsx
│   │   ├── Caption.tsx
│   │   ├── SpeechBubble.tsx
│   │   └── Props.tsx
│   │
│   ├── scenes/
│   │   ├── IntroScene.tsx
│   │   ├── DialogueScene.tsx
│   │   ├── StatementScene.tsx
│   │   ├── ReactionScene.tsx
│   │   ├── ChaosScene.tsx
│   │   ├── PunchlineScene.tsx
│   │   └── OutroScene.tsx
│   │
│   ├── animations/
│   │   ├── float.ts
│   │   ├── bounce.ts
│   │   ├── shake.ts
│   │   └── zoom.ts
│   │
│   ├── effects/
│   │   ├── Alarm.tsx
│   │   ├── Rain.tsx
│   │   └── Sparkles.tsx
│   │
│   ├── schema/
│   │   └── story.ts
│   │
│   ├── StoryRenderer.tsx
│   ├── Video.tsx
│   └── Root.tsx
│
├── scripts/
│   └── render.ts
│
├── package.json
└── README.md
~~~

Esta estructura es orientativa y puede cambiar durante la implementación.

## MVP

La primera versión se mantiene deliberadamente pequeña y demuestra un único vertical slice:

~~~text
story.yaml
    ↓
validation
    ↓
timeline
    ↓
reusable visuals
    ↓
Remotion
    ↓
video.mp4
~~~

Alcance de v0.1:

- 1 personaje: Tora;
- 4 poses: `formal`, `confused`, `panic`, `coffee`;
- 2 fondos: `office`, `server-room`;
- 4 scene presets: `intro`, `dialogue`, `chaos`, `punchline`;
- 3 animaciones: `fade`, `float`, `slowZoom`;
- 1080 × 1920, 30 FPS;
- YAML como input;
- H.264 MP4 como output.

La IA, TTS, audio, props, character packs y generación dinámica de imágenes quedan fuera del MVP.

El roadmap implementable y los criterios de aceptación viven en **[docs/mvp/](docs/mvp/README.md)**. Las specs de esa carpeta son la fuente de verdad para v0.1.

## Roadmap

### Phase 1 — Renderer / MVP v0.1

La implementación concreta de esta fase está dividida en specs secuenciales en **[docs/mvp/](docs/mvp/README.md)**:

1. Remotion bootstrap.
2. Story domain and timeline.
3. YAML input and validation.
4. Visual primitives and scene presets.
5. Render command.
6. Reference story and verification.

### Phase 2 — Content engine

- Character manifests.
- Props.
- Sound effects.
- Music.
- More scene types.
- Narrative templates.
- Automatic scene timing.

### Phase 3 — AI

- Prompt → story.
- Writer agent.
- Director agent.
- Automatic asset selection.
- Story validation and repair.

### Phase 4 — Audio

- Text-to-Speech.
- Automatic scene duration.
- Word-level subtitles.
- Sound-effect selection.

### Phase 5 — Full generator

Experiencia objetivo:

~~~bash
tora make "Tora descubre que alguien hizo force push a main"
~~~

Pipeline:

~~~text
Prompt
   ↓
Writer
   ↓
Director
   ↓
Story YAML
   ↓
Asset resolver
   ↓
TTS
   ↓
Remotion
   ↓
MP4
~~~

## Tech stack

Base prevista:

- TypeScript
- React
- Remotion
- YAML
- Zod

Posibles integraciones futuras:

- LLMs para story generation y dirección visual;
- TTS para narración;
- image generation para nuevos assets;
- FFmpeg para post-processing;
- GitHub Actions para rendering automatizado.

## Example

Input:

~~~yaml
title: "Force push"

scenes:
  - type: intro
    character: tora
    pose: coding
    background: office
    text: "Tora abrió GitHub."

  - type: dialogue
    character: tora
    pose: confused
    animation: slowZoom
    text: "¿Por qué faltan 14 commits?"

  - type: chaos
    character: tora
    pose: panic
    effect: alarm
    text: "force push"

  - type: punchline
    character: tora
    pose: coffee
    text: "Tora cerró GitHub."
~~~

Conceptualmente:

~~~text
┌──────────────────────────┐
│                          │
│           TORA           │
│                          │
│    "Tora abrió GitHub"   │
│                          │
│            ↓             │
│                          │
│   "¿Por qué faltan       │
│     14 commits?"         │
│                          │
│            ↓             │
│                          │
│       FORCE PUSH         │
│                          │
│            ↓             │
│                          │
│    "Tora cerró GitHub"   │
│                          │
└──────────────────────────┘
~~~

## Status

Experimental.

La primera meta es construir un renderer pequeño y funcional capaz de transformar historias YAML en videos cortos utilizando assets estáticos y animaciones de Remotion.

El criterio de éxito inicial es simple:

~~~text
story.yaml → video.mp4
~~~
