# 🔥 Fósforos — Torneo multijugador

El clásico juego de los fósforos: por turnos se sacan 1 o 2 fósforos y **el que saca el último pierde**.
Se juega en salas con código, en formato torneo por eliminación hasta que queda un campeón.

## Cómo correrlo

```bash
npm install
npm start
```

Abrí http://localhost:3000. Al arrancar, la consola muestra también la dirección para tu red local
(ej. `http://192.168.0.10:3000`) para que se sumen desde otros dispositivos de la misma red Wi‑Fi.

## Cómo se juega (torneo por absorción)

1. Quien crea el torneo lo organiza y comparte el código de 4 letras; los demás se inscriben con su nombre.
   Al iniciarlo ya no se puede inscribir nadie más (los que llegan tarde pueden mirar).
2. Cada inscripto arranca como un equipo de un integrante. Las partidas son de a dos equipos, todas a la vez.
3. **El que saca el último fósforo pierde, pero no queda afuera: se suma al equipo que le ganó.**
4. En su turno, cada integrante del equipo vota cuántos fósforos sacar (20 segundos). Se juega lo que votó la mayoría;
   si hay empate, decide la máquina con MIN-MAX. Antes de aplicarla, todos ven la jugada que ganó.
5. Cada ronda sortea cuántos fósforos hay (10 a 30) y el máximo por turno (2 a 4), distintos en cada ronda.
6. Empieza el equipo con menos integrantes (si son iguales, se sortea). Si sobra un equipo, juega contra la máquina;
   si pierde, se suma a un equipo al azar.
7. Una ronda termina cuando terminaron todas sus partidas. Se sigue hasta la final entre los dos últimos equipos,
   y se muestra el equipo campeón con todos sus integrantes.
8. Quien organiza tiene la **vista de proyector**: todas las partidas de la ronda y qué equipo está en posición
   ganadora según MIN-MAX.

Con **🤖 Jugar con bots** jugás vos con 5 bots para probarlo sin nadie más.

## Estructura

- `server.js` — servidor Express + Socket.IO: salas, llave del torneo, turnos y temporizadores.
- `public/index.html`, `public/style.css`, `public/app.js` — interfaz.
- `public/music.js` — música procedural con Web Audio.
