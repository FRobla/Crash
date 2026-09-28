# ADR 0001 — Autoridad de settlement de Crash

- Estado: **propuesto** (pendiente de aceptación; no hay código que dependa de esta decisión)
- Fecha: 2026-09-28
- Relacionado: [ADR 0002](0002-randomness-source.md), [spec de reglas de ronda](../specs/crash-round-rules.md)

## Contexto

`CLAUDE.md` exige que los eventos económicos sean verificables on-chain, que ningún servicio off-chain sea silenciosamente la autoridad sobre dinero o resultados, y que el orden de cash-outs, auto cash-outs, cierres y crash **no dependa del orden de llegada observado por un único servidor**.

Hay que decidir qué componente es la autoridad que:
1. acepta apuestas y aplica límites,
2. fija el instante reconocido de cada cash-out (el "tick" de la spec),
3. calcula y paga el resultado.

El motor de dominio (`src/games/crash/domain/`) ya está diseñado para ser independiente de esta decisión: trabaja con ticks abstractos y resuelve la ronda como función pura de apuestas, solicitudes de cash-out con su tick reconocido y crash point.

## Criterios

| Criterio | Qué se evalúa |
| --- | --- |
| Confianza | Quién puede alterar orden, resultado o pagos; qué debe creer el jugador |
| Orden verificable | Si el tick reconocido de un cash-out es observable y reproducible por terceros |
| Latencia | Tiempo entre la acción del jugador y su reconocimiento |
| Coste | Comisiones por apuesta/cash-out, rent de cuentas |
| Custodia | Quién controla los fondos del house bank y de los jugadores en tránsito |
| Fallos | Congestión, caída del operador, reorgs/forks, reintentos |
| Complejidad | Lenguajes, toolchains y auditorías nuevas |

## Opciones

### A. Programa on-chain como autoridad (recomendada, preliminar)

Un programa de Solana custodia el vault del house bank y registra apuestas y cash-outs. **Tick = slot**: el tick reconocido de un cash-out manual es el slot en que se incluye su transacción, relativo al slot de inicio de la ronda. Tras conocerse el crash point, cualquiera puede ejecutar la liquidación, que el programa calcula con las mismas reglas que el motor de dominio.

- Confianza: el orden lo fija el consenso de Solana, no el operador. El operador conserva liveness (abrir rondas, revelar randomness) pero no puede alterar resultados ya fijados; los fallos de liveness se cubren con reglas de timeout (ver ADR 0002).
- Orden verificable: sí; el slot de inclusión es público.
- Latencia: un slot ≈ 400 ms en condiciones normales. El jugador asume la latencia entre su clic y la inclusión; la UI debe comunicarlo. El auto cash-out no necesita transacción durante la ronda y es inmune a la latencia.
- Coste: comisión base + priority fees por apuesta y por cash-out manual; rent de cuentas de ronda/apuesta (recuperable al cerrarlas).
- Custodia: fondos en PDAs del programa; ninguna clave del operador puede retirarlos fuera de las reglas (si la autoridad de upgrade se gestiona correctamente).
- Fallos: bajo congestión, cash-outs manuales pueden llegar tarde y perder; mitigación con auto cash-out, priority fees y avisos. Los resultados se consideran definitivos solo con compromiso `finalized`.
- Complejidad: introduce **Rust + un framework de programas (Anchor como candidato; alternativas: Rust nativo, Pinocchio)**, `solana-cli`/`anchor-cli`, pruebas del programa (p. ej. LiteSVM/bankrun) y auditoría externa antes de mainnet. Límites de compute units por instrucción.

### B. Operador off-chain con vault on-chain

Un servidor recibe apuestas y cash-outs por WebSocket, decide el orden y liquida por lotes con recibos firmados; el vault on-chain solo guarda fondos.

- Confianza: el operador decide el orden y la hora de cada cash-out. **Incumple el requisito de no depender del orden de llegada de un único servidor.** Los recibos firmados permiten disputas pero no impiden la manipulación del orden.
- Latencia y coste: mejores (sin transacción por cash-out).
- Complejidad: menor en la cadena, mayor en la operación (disputas, custodia de claves del servidor).

### C. Híbrido

Apuestas y liquidación on-chain; cash-outs manuales ordenados off-chain por el operador con compromisos periódicos (p. ej. raíz Merkle por ronda) publicados on-chain.

- Mejora la latencia de B pero mantiene al operador como autoridad del orden; la publicación del compromiso después de conocer el resultado sigue permitiendo reordenar. Solo sería aceptable con un secuenciador independiente, que no existe en el repositorio.

## Recomendación preliminar

**Opción A.** Es la única que cumple sin supuestos adicionales los requisitos de orden verificable y de no convertir al operador en autoridad económica. El coste es latencia percibida en cash-outs manuales, comisiones por transacción y la introducción de Rust y un toolchain de programas.

## Consecuencias si se acepta

- Se añadirá un directorio para el programa on-chain (p. ej. `chain-adapters/solana/programs/crash` o un workspace Anchor en la raíz; decidir al implementar) y su toolchain.
- El programa debe reimplementar las reglas del motor con resultados **idénticos**. Los vectores de prueba generados desde `src/games/crash/domain/` serán la referencia compartida entre TypeScript y Rust.
- Los parámetros de la curva (`growthPpm`) se eligen para ticks de un slot.
- La UI mostrará el estado de confirmación (`processed`/`confirmed`/`finalized`) de cada apuesta y cash-out, y solo mostrará como definitivo lo liquidado con `finalized`.
- El house bank se implementa como vault del programa con límites de exposición aplicados on-chain.

## Preguntas abiertas

1. Framework del programa: Anchor, Rust nativo o Pinocchio.
2. ¿Quién puede ejecutar la liquidación (cualquiera / operador) y quién paga sus comisiones?
3. Gestión de la autoridad de upgrade del programa (multisig, timelock, congelación).
4. Priority fees: ¿las paga el jugador, el operador o se subsidian?
