# bobobike

Obby infinito e procedural no estilo Roblox, jogado de BMX, scooter elétrica ou patinete.
A pista nunca acaba: o objetivo é bater o seu recorde de distância. No fim da corrida aparece a
sua **velocidade média** com uma nota (S, A, B, C, D), então não vale parar.

**Jogar:** https://erereck.github.io/bobobike/

Roda direto no navegador (PC e celular), sem instalar nada. Feito com [Three.js](https://threejs.org/) 0.160.

## Controles

| Tecla | Ação |
|---|---|
| W / ↑ | acelerar |
| S / ↓ | frear (no ar também, freia forte) |
| A D / ← → | virar |
| Espaço | pular |
| Shift | turbo |
| Q | mortal (no ar) |
| E | giro 360 (no ar) |
| R | voltar ao checkpoint |
| Esc | pausar |
| M | som |
| Botão direito + arrastar | girar a câmera |
| Rodinha | zoom |

**Celular:** joystick no polegar esquerdo (pra cima acelera, pra baixo freia, pros lados vira), botões de PULO, TURBO, MORTAL e GIRO à direita, e arrastar no lado direito da tela gira a câmera. Tem vibração (dá pra desligar) e botão de tela cheia. Controle de videogame também funciona.

## Como funciona

- **Modos:** *Normal* (começa com 3 vidas e ganha +1 a cada 3 checkpoints, máximo 6) e *Vidas Infinitas* (sem game over, recordes separados; encerre pela pausa).
- **Zonas:** a cada ~620 m o céu muda (dia, tarde, pôr do sol, noite neon, aurora, nebulosa, amanhecer).
- **Skins:** 4 grátis e 3 desbloqueadas pelo recorde do modo Normal (500 m, 1200 m e 2500 m).
- **Recordes** ficam salvos no navegador (localStorage).

## Rodar localmente

Os arquivos são estáticos, mas módulos ES precisam de um servidor HTTP (abrir o `index.html` direto do disco não funciona):

```bash
node tools/serve.mjs . 5179
```

Depois abra http://localhost:5179.

## Estrutura

| Arquivo | O que faz |
|---|---|
| `index.html` | página, estilos, HUD e menus |
| `js/main.js` | loop do jogo, câmera, input, estados, recordes |
| `js/track.js` | gerador procedural da pista, colisão e renderização instanciada |
| `js/player.js` | física do veículo e manobras |
| `js/vehicles.js` | modelos 3D dos veículos e do personagem estilo Roblox R6, skins |
| `js/environment.js` | céu, nuvens, mar de nuvens, ilhas, luz e sombras |
| `js/fx.js` | partículas, confete, linhas de velocidade, rastro |
| `js/audio.js` | sons e música gerados por código (WebAudio) |
| `js/ui.js` | interface |
| `js/config.js`, `js/themes.js` | ajustes, veículos, skins e temas das zonas |
| `SPEC.md`, `PROGRESS.md` | arquitetura e notas de desenvolvimento |
| `dev/`, `tools/` | página de teste com módulos falsos, servidor local e bot de teste automático |
