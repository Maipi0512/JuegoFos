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

## Cómo se juega

1. Alguien crea una sala y comparte el código de 4 letras (o el link de invitación).
2. El anfitrión configura las reglas: fósforos por partida (o al azar), máximo por turno (2–4) y tiempo por turno.
3. Al empezar se arma la llave al azar. Si son impares, alguien pasa directo (pase libre).
4. El que se queda con el último fósforo queda eliminado; los ganadores avanzan hasta la final.
5. Los eliminados pueden seguir mirando las demás partidas en vivo.

Detalles:
- Si se acaba el tiempo del turno, se saca 1 fósforo automáticamente.
- Si alguien se desconecta en plena partida y no vuelve en 30 s, pierde esa partida.
- Recargar la página no te saca de la sala.
- Música de fondo generada en el navegador (botón 🎵) y efectos de sonido (botón 🔊).

## Estructura

- `server.js` — servidor Express + Socket.IO: salas, llave del torneo, turnos y temporizadores.
- `public/index.html`, `public/style.css`, `public/app.js` — interfaz.
- `public/music.js` — música procedural con Web Audio.
