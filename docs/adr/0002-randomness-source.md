# ADR 0002 — Fuente de randomness y ciclo provably fair

- Estado: **propuesto** (pendiente de aceptación; no se implementa ningún algoritmo ni proveedor hasta aceptarlo)
- Fecha: 2026-09-28
- Relacionado: [ADR 0001](0001-settlement-authority.md), [spec de reglas de ronda](../specs/crash-round-rules.md)

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
| Sesgo del proveedor VRF | La prueba VRF es verificable; el proveedor no conoce `s` | Riesgo residual: colusión proveedor + operador |
| **No revelación selectiva** | El operador ve los cash-outs y conoce el resultado; si le es desfavorable, podría no revelar | **Una no revelación tras empezar la ronda no puede acabar en reembolso simple**, porque eso sería una opción gratuita para el operador. Regla penalizadora (`forfeit`): se liquida como si el crash point fuera el máximo y las apuestas sin cash-out se reembolsan. Invariante probado: para el house, el forfeit siempre es igual o peor que revelar |
| Fallo del VRF antes de empezar | Nadie conoce el resultado | `void` con reembolso íntegro. Esto no da ventaja a nadie, porque sin `e` el operador tampoco conoce el resultado |
| **Colusión operador–jugador** | El operador conoce el resultado durante la ronda y podría filtrarlo | **Riesgo residual principal.** Perjudica al house bank. Si el bank tiene financiadores externos, estos deben confiar en el operador. Mitigaciones futuras: custodiar `s` en TEE o con un umbral de firmantes; monitorizar retiros anómalamente cercanos al crash |
| Repetición | Reutilizar `s` o `e` en otra ronda | Tags de dominio + `round_id` + `program_id`. El programa rechaza semillas o compromisos repetidos |
| Caída del operador | No se abren rondas o no se revela | La liveness se pierde, pero la seguridad se mantiene: timeout → `void` antes de empezar o `forfeit` después |
| Sesgo de selección de rondas | El operador podría descartar rondas antes de publicarlas | Toda ronda con compromiso publicado debe terminar en `settled`, `void` o `forfeit`, y todas son visibles para el verificador |

## Verificación independiente

El verificador (página Fairness y código abierto) recibe `commit`, `s`, `e` junto con la prueba VRF, `program_id`, `round_id` y los parámetros de la ronda. Con ellos:
1. comprueba el compromiso y la prueba VRF;
2. recalcula `entropy` y, con `crashPointFromEntropy`, el crash point;
3. recalcula la liquidación con `settleRound`.

Los parámetros del algoritmo se versionan por ronda para que los verificadores históricos sigan funcionando. Una ronda que no se pueda verificar se marca de forma visible.

## Recomendación preliminar

**Opción C**: compromiso por ronda o hash chain, más VRF solicitado al cerrar las apuestas, más la regla `forfeit` para la no revelación. Supuesto de confianza residual declarado: **el operador conoce el resultado durante la ronda y podría filtrarlo**.

## Preguntas abiertas

1. Proveedor VRF: Switchboard On-Demand u ORAO. Hay que medir en devnet latencia, coste y disponibilidad.
2. ¿Hash chain o compromiso independiente por ronda?
3. Timeouts concretos, en slots: cumplimiento del VRF, revelación y liquidación.
4. ¿Es aceptable el riesgo de colusión para el MVP, o se exige desde el inicio custodia de `s` en TEE o por umbral?
