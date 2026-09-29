# ADR 0004 — Canal en vivo del crank (solo presentación)

- Estado: **propuesto** (2026-09-29). Implementado en la iteración 9 para desarrollo local; su despliegue público queda pendiente (ver [Consecuencias](#consecuencias)).
- Fecha: 2026-09-29
- Relacionado: [ADR 0001](0001-settlement-authority.md) (autoridad de settlement, sin cambios), [ADR 0002](0002-randomness-source.md) (esquema C, sin cambios), [spec del cliente](../specs/crash-client-v1.md) §4.7, §5 y §10.

## Contexto

La web solo conoce el crash point cuando lee la cuenta `Round` revelada. Con la RPC pública eso llega ≈ 3 s tarde (el crank duerme entre pasos, la web sondea cada segundo y web3.js reintenta los 429): la curva sigue subiendo ≈ 14 ticks por encima del crash real (p. ej. x5 y luego crash en x3.5). Un jugador que pulsa cash-out en ese intervalo ve su transacción confirmada, pero pierde al liquidar, porque el programa solo acepta cash-outs con `tick < crash_tick`.

El crank conoce la semilla y el momento exacto del reveal. Publicarlo en cuanto el `reveal` pasa la simulación permite a la web detener la curva a tiempo.

## Decisión

El crank sirve un canal **Server-Sent Events** de solo lectura con `node:http` (sin dependencias nuevas):

- **Eventos:** pistas de fase (`opened`, `betting-closed`, `started`, `revealed`, `voided`, `forfeited`) con el id de ronda, y `crashed {roundId, seedHex}`. Al conectar se envía una instantánea con el último evento de cada tipo, y un comentario de heartbeat cada 15 s.
- **La semilla sale solo después de que el `sendRawTransaction` del `reveal` pase el preflight** (simulación con compromiso `confirmed`). El `reveal` nunca se envía con `skipPreflight`. Así, un reveal prematuro que falla no publica la semilla antes del crash tick.
- **Solo presentación:** la web **verifica** la semilla contra el `commit` y el `vrf_output` on-chain de la ronda con el verificador compartido (`deriveOutcome`) y solo entonces muestra un crash **provisional**, marcado como "reveal on-chain pendiente". Todo lo económico (oferta de cash-out, resultado, saldo) sigue saliendo de la cadena o de las reglas aplicadas a datos verificados. Una semilla que no cuadra se descarta sin efectos.
- **Sin feed, la web funciona igual** con los datos on-chain (fallback): el canal mejora la latencia, no la corrección.
- **Solo local:** escucha en `127.0.0.1`, CORS con un único origen exacto (`CRASH_OPERATOR_LIVE_ORIGIN`), límite de conexiones y ningún dato de entrada más allá de la ruta. En la web, `NEXT_PUBLIC_CRASH_LIVE_FEED_URL` es opcional y solo admite `https`, o `http` hacia `localhost`/`127.0.0.1`.

## Por qué no revela ventaja

`settle_bet` solo paga cash-outs manuales con `tick < crash_tick`, y el preflight del `reveal` ya ha comprobado que el banco `confirmed` está en `slot ≥ start_slot + crash_tick`: cualquier transacción nueva aterriza en un slot posterior y pierde igual. Además, el propio `reveal` pone la semilla en la red en ese momento. `reveal` no tiene permisos: un consumidor del feed podría enviarlo él mismo, lo que solo aporta disponibilidad.

## Amenazas

| Amenaza | Tratamiento |
| --- | --- |
| Feed malicioso o suplantado (entrada no confiable) | La web valida la forma (hex de 64, ronda actual) y verifica la semilla contra el commit on-chain. Un dato falso no se muestra; como mucho, el feed puede callar y la web vuelve al modo on-chain |
| Semilla publicada antes del crash | Solo tras el preflight del reveal; nunca con `skipPreflight` (assert y prueba). La semilla no se escribe en logs |
| Fork o reveal que no aterriza tras un preflight correcto | La semilla ya no da ventaja (sección anterior). La web muestra el crash como provisional hasta leer la cuenta revelada; si la ronda acaba en `forfeit`, se sustituye por el resultado on-chain |
| DoS contra el crank | Solo `127.0.0.1`, límite de conexiones, sin cuerpo de petición, sin estado por cliente más allá del socket. Un fallo del canal no detiene el crank |
| Otra web del navegador leyendo el canal | CORS de origen exacto; los datos son públicos igualmente tras el preflight |
| Reintentos de la web que disparan 429 | Las pistas solo adelantan un sondeo, con ≥ 300 ms entre sondeos |

## Consecuencias

- La curva se detiene en el crash real con una latencia de ≈ 1 slot más la red local, en vez de ≈ 3 s.
- **Despliegue público pendiente:** una web en `https` no puede leer `http://127.0.0.1` (contenido mixto y Local Network Access de Chrome). Publicarlo exige TLS detrás de un proxy, con límites de conexión y de tasa. Es una decisión del usuario (checklist, iteración 9 §9).
- El crank sigue siendo un único proceso; el canal no añade estado persistente ni autoridad.
