# ADR 0002 — Fuente de randomness y ciclo provably fair

- Estado: **aceptado** el 2026-09-28.
  - Esquema C y regla `forfeit`: aceptados en la primera revisión.
  - Proveedor y diseño de integración: aceptados tras el [spike en devnet](../spikes/vrf-devnet.md) (sección «Decisión final»).
- Fecha: 2026-09-28
- Relacionado: [ADR 0001](0001-settlement-authority.md), [spec de reglas de ronda](../specs/crash-round-rules.md), [spec del programa](../specs/crash-program.md)

## Contexto

El motor deriva el crash point de 32 bytes de entropía opaca (`crashPointFromEntropy`). Este ADR decide de dónde salen esos bytes y cómo se verifican.

### El problema central: el crash point debe ser secreto durante la ronda

En Crash el jugador decide cuándo retirarse mientras el multiplicador sube. **Si el crash point es público antes de que termine la ronda, cualquiera puede retirar justo antes del crash** y la ventaja de la casa desaparece. Por tanto:

- Un VRF cuya salida se publica on-chain en cuanto se genera **no basta por sí solo**: su salida sería legible durante la ronda.
- El programa on-chain (ADR 0001, opción A) tampoco puede conocer el crash point durante la ronda. Registra los cash-outs con su slot y **resuelve después**, cuando se revela la entropía: gana todo cash-out con multiplicador reconocido `≤ crashPoint` (regla única de la spec). Revelar tarde no cambia el resultado, porque la regla depende del tick reconocido, no del momento de la revelación.

Alguien tiene que guardar un secreto durante la ronda. La pregunta es cómo impedir que ese alguien elija o sesgue el resultado.

## Opciones

### A. Commit-reveal del operador (hash chain)

El operador genera una cadena `sₙ … s₀` con `sᵢ = H(sᵢ₊₁)`, publica `s₀` por adelantado y revela un eslabón por ronda.

- A favor: sencillo, barato y verificable con un hash.
- En contra: **el operador conoce todos los resultados futuros**. No puede cambiarlos, pero sí filtrarlos a un cómplice. La entropía depende solo del operador.

### B. VRF de un proveedor (candidatos: Switchboard On-Demand, ORAO VRF)

- A favor: entropía impredecible y no sesgable por el operador, con prueba verificable on-chain.
- En contra: por sí solo **no mantiene el secreto** (ver arriba). Además añade latencia de cumplimiento, coste por solicitud, dependencia de la liveness del proveedor y su modelo de confianza. Coste y latencia están pendientes de medir en devnet.

### C. Combinación: semilla comprometida + entropía pública posterior (recomendada, preliminar)

```
antes de abrir apuestas : commit = H(tag_commit ‖ s)        (publicado on-chain)
al cerrar apuestas      : se solicita e (VRF)                 (e desconocido para todos)
al revelar              : entropy = H(tag_round ‖ program_id ‖ round_id ‖ s ‖ e)
```

- Nadie conoce el resultado mientras se aceptan apuestas: el jugador no conoce `s` y el operador no conoce `e`.
- El operador no puede elegir el resultado: `s` queda fijado antes de conocer `e`.
- `e` es público cuando llega, pero sin `s` no revela nada. Por eso **el secreto durante la ronda lo guarda el operador**.
- Los tags de dominio, `program_id` y `round_id` impiden reutilizar una revelación en otra ronda, programa o red.
- Opcionalmente, `s` puede proceder de una hash chain (opción A). Así se demuestra además que las semillas quedaron fijadas mucho antes.

Hash candidato: SHA-256. Se elige por su disponibilidad como syscall barato en Solana y su soporte universal en los verificadores, y queda sujeto a esta aceptación. El motor no depende de él.

## Análisis de amenazas (opción C)

| Amenaza | Situación | Mitigación / riesgo residual |
| --- | --- | --- |
| Predicción por jugadores | Requiere conocer `s` antes de revelarse | Secreto de `s`; se exige que nunca se registre ni aparezca en logs |
| Elección del resultado por el operador | `s` está comprometido antes de conocer `e` | Verificación `H(tag ‖ s) = commit` |
| Sesgo del proveedor VRF | El proveedor no conoce `s`; con Switchboard, on-chain solo se verifica la firma del oráculo (TEE), no una prueba VRF | Riesgo residual: integridad del TEE y colusión oráculo + operador (decisión final, punto 5) |
| **No revelación selectiva** | El operador ve los cash-outs y conoce el resultado; si le es desfavorable, podría no revelar | **Una no revelación tras empezar la ronda no puede acabar en reembolso simple**, porque eso sería una opción gratuita para el operador. Regla penalizadora (`forfeit`): se liquida como si el crash point fuera el máximo y las apuestas sin cash-out se reembolsan. Invariante probado: para el house, el forfeit siempre es igual o peor que revelar |
| Fallo del VRF antes de empezar | Nadie conoce el resultado | `void` con reembolso íntegro. Esto no da ventaja a nadie, porque sin `e` el operador tampoco conoce el resultado |
| **Colusión operador–jugador** | El operador conoce el resultado durante la ronda y podría filtrarlo | **Riesgo residual principal.** Perjudica al house bank. Si el bank tiene financiadores externos, estos deben confiar en el operador. Mitigaciones futuras: custodiar `s` en TEE o con un umbral de firmantes; monitorizar retiros anómalamente cercanos al crash |
| Repetición | Reutilizar `s` o `e` en otra ronda | Tags de dominio + `round_id` + `program_id`. El programa rechaza semillas o compromisos repetidos |
| Caída del operador | No se abren rondas o no se revela | La liveness se pierde, pero la seguridad se mantiene: timeout → `void` antes de empezar o `forfeit` después |
| Sesgo de selección de rondas | El operador podría descartar rondas antes de publicarlas | Toda ronda con compromiso publicado debe terminar en `settled`, `void` o `forfeit`, y todas son visibles para el verificador |

## Verificación independiente

El verificador (página Fairness y código abierto) recibe `commit`, `s`, `e` junto con la cuenta de randomness y el `seed_slot` de Switchboard, `program_id`, `round_id` y los parámetros de la ronda. Con ellos:
1. comprueba el compromiso y que `e` coincide con el valor revelado on-chain por Switchboard para la cuenta y el `seed_slot` guardados en la ronda;
2. recalcula `entropy` y, con `crashPointFromEntropy`, el crash point;
3. recalcula la liquidación con `settleRound`.

Los parámetros del algoritmo se versionan por ronda para que los verificadores históricos sigan funcionando. Una ronda que no se pueda verificar se marca de forma visible.

## Recomendación preliminar

**Opción C**: compromiso por ronda o hash chain, más VRF solicitado al cerrar las apuestas, más la regla `forfeit` para la no revelación. Supuesto de confianza residual declarado: **el operador conoce el resultado durante la ronda y podría filtrarlo**.

## Decisión (parcial)

Se aceptan:
- el **esquema C**: `entropy = H(tag_round ‖ program_id ‖ round_id ‖ s ‖ e)`, con `s` comprometida antes de abrir las apuestas y `e` procedente de un VRF solicitado al cerrarlas;
- la regla **`forfeit`** para una no revelación tras empezar la ronda;
- el supuesto de confianza residual (el operador conoce el resultado durante la ronda), aceptado para el MVP en devnet.

Siguen abiertas las preguntas 1 a 4. El spike resuelve la 1. La 3 se concreta en la spec del programa.

## Decisión final (aceptada el 2026-09-28)

Se basa en los datos medidos en el [spike](../spikes/vrf-devnet.md): 100/100 rondas correctas en devnet, p95 de 28 slots y 10 000 lamports por ronda.

1. **Proveedor: Switchboard On-Demand** (randomness commit/reveal). ORAO queda descartado porque no es compatible con Anchor 1.x.
2. **La authority de la cuenta de randomness de la casa es una PDA del programa.** Switchboard exige esa firma para `randomness_init`, `randomness_commit` y `randomness_reveal`, y el payload del reveal lo puede obtener cualquiera del gateway. Si la authority fuese el operador, conocería `e` (y con ello el crash point) antes que nadie y podría dejar la ronda sin empezar para forzar un reembolso. Con la PDA:
   - la cuenta se crea con una instrucción del admin que hace la CPI de `randomness_init`;
   - `close_betting` hace la CPI de `randomness_commit`;
   - `start_round` hace la CPI de `randomness_reveal` y lee el valor en la misma instrucción;
   - `close_betting` y `start_round` son sin permisos: cualquier jugador o vigilante puede empezar la ronda con el payload público.
3. **Liveness:** si la ronda sigue en `Betting` pasado `betting_end_slot + entropy_timeout_slots`, cualquiera puede anularla. Antes de ese slot solo puede el operador.
4. **Integración sin el crate de Switchboard:** el programa construye las tres CPIs y lee la cuenta con un adaptador propio y mínimo. El crate arrastra dependencias (p. ej. `libsecp256k1`) que el programa no necesita y no trae CPI de reveal. El adaptador se prueba contra el IDL on-chain fijado, contra una cuenta real de devnet y contra un mock en LiteSVM.
5. **Supuesto de confianza residual:** además de lo ya aceptado (el operador conoce el resultado durante la ronda), se confía en la integridad del TEE y del oráculo de Switchboard. On-chain se verifica la firma secp256k1 del oráculo, pero su salida **no es una prueba VRF verificable matemáticamente por terceros**. El oráculo solo no puede calcular el crash point porque no conoce `s`. En colusión con el operador, sí: el oráculo podría negarse a revelar cuando el resultado fuese desfavorable para la casa y forzar un `void` con reembolso. Queda declarado como riesgo residual; un indicador vigilable es la tasa de rondas anuladas por timeout de entropía.
6. **Riesgo de liveness aceptado:** quien ejecute `close_betting` elige el oráculo de la cola (Switchboard valida que pertenezca a ella). Un oráculo caído solo provoca un `void` con reembolso íntegro tras el timeout; nadie obtiene ventaja económica.

## Preguntas resueltas

1. Proveedor VRF: **Switchboard On-Demand** (decisión final, punto 1).
2. Hash chain o compromiso por ronda: **compromiso independiente por ronda** para el MVP. La hash chain queda como mejora opcional.
3. Timeouts en slots: `betting_slots = 25`, `entropy_timeout_slots = 150` (5x el máximo medido), `reveal_grace_slots = 150`. Configurables en `HouseConfig`.
4. Riesgo de colusión: **aceptado para el MVP en devnet**. Antes de fondos reales se reevalúa la custodia de `s` en TEE o por umbral.
