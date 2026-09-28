# Spec — Reglas de ronda de Crash (motor de dominio)

- Estado: **borrador v0.1**. Los parámetros marcados como *propuesto* no están aprobados. Esta spec no habilita fondos reales.
- Fecha: 2026-09-28
- Implementación: `src/games/crash/domain/`
- Decisiones relacionadas: [ADR 0001 — settlement](../adr/0001-settlement-authority.md), [ADR 0002 — randomness](../adr/0002-randomness-source.md). Ambos están propuestos.

## 1. Alcance

Define las reglas deterministas que deciden el resultado económico de una ronda de Crash. El motor es **puro**:
- no conoce la cadena, la wallet, el token, el proveedor de randomness ni la UI;
- no lee el reloj;
- no genera aleatoriedad.

Recibe estos datos ya fijados por la autoridad de settlement:
- los parámetros de la ronda;
- las apuestas aceptadas;
- las solicitudes de cash-out con su **tick reconocido**;
- el crash point, derivado de entropía verificable.

Con ellos produce la liquidación. La misma entrada produce siempre la misma salida, en cualquier plataforma.

Fuera de alcance: custodia, firma y envío de transacciones, generación y verificación de la entropía (ADR 0002), mapeo de ticks a tiempo real (ADR 0001), proyecciones en tiempo real y UI.

## 2. Unidades y aritmética

| Magnitud | Representación | Notas |
| --- | --- | --- |
| Importe (`Amount`) | `bigint` ≥ 0 en unidades base del activo | lamports para SOL y 10⁻⁶ para USDC. **Nunca `number`** |
| Multiplicador (`Multiplier`) | `bigint` en diezmilésimas (`1.0000x = 10_000n`) | Precisión interna de la curva |
| Multiplicador reconocido | Multiplicador truncado a centésimas (múltiplo de `100n`) | Es lo que se muestra, se compara y se paga |
| Tick | Entero seguro ≥ 0 | Tick 0 = inicio de la ronda. La duración real la fija la autoridad (ADR 0001) |

- Toda división es entera con truncamiento hacia cero. Todos los operandos son no negativos, así que equivale a `floor`.
- `payout(stake, m) = ⌊stake · m / 10_000⌋`. El redondeo favorece al house en como mucho 1 unidad base por apuesta.

## 3. Ciclo de vida

```
betting ──close-betting──▶ awaiting-entropy ──start──▶ running ──crash──▶ crashed ──settle──▶ settled
   │                             │                        │
   └────────── void ─────────────┘                        └──forfeit──▶ forfeited
                 ▼
               voided
```

| Fase | Significado | Apuestas | Cash-outs |
| --- | --- | --- | --- |
| `betting` | Ventana de apuestas abierta | Se aceptan si cumplen los límites (§7) | No |
| `awaiting-entropy` | Apuestas cerradas; se espera la entropía pública (ADR 0002) | No | No |
| `running` | La curva avanza por ticks | No (MVP) | Se registran con su tick reconocido |
| `crashed` | El crash point es conocido y verificable | No | No |
| `settled` | Liquidación calculada con `settleRound` | — | — |
| `voided` | Cancelada **antes** de `running` | — | Reembolso íntegro (`refundRound`) |
| `forfeited` | No hubo revelación tras empezar | — | Liquidación penalizadora (`settleForfeitedRound`, §6.4) |

- Toda transición no listada se rechaza con un error tipado; nunca lanza.
- **`void` solo es posible antes de `running`**, cuando nadie conoce el resultado. Si una ronda empezada pudiera anularse con reembolso, el operador tendría una opción gratuita contra resultados desfavorables (ADR 0002).
- *Decisión abierta:* apuestas durante `running`. El MVP no las admite.

## 4. Curva del multiplicador

```
m₀     = 10_000
mₙ₊₁   = mₙ + ⌊mₙ · growthPpm / 1_000_000⌋
reconocido(n) = ⌊mₙ / 100⌋ · 100
```

- `growthPpm ∈ [1_000, 1_000_000]`. Con `growthPpm ≥ 100` la curva ya es estrictamente creciente; el mínimo de 1_000 acota el tamaño de la tabla.
- La curva se precalcula hasta el primer tick cuyo multiplicador reconocido supera `maxMultiplier`, que es el horizonte. Consultar un tick fuera del horizonte es un error de programación (`RangeError`).
- **Crash tick** de un crash point `c`: el primer tick `n` con `reconocido(n) > c`. Siempre existe dentro del horizonte, porque `c ≤ maxMultiplier`.
- *Propuesto:* `growthPpm = 24_000` (+2.4 % por tick). Con ticks de un slot (≈400 ms) da unos 2x a los 12 s y 10x a los 39 s. Queda pendiente de ADR 0001.

## 5. Crash point

Entrada: exactamente **32 bytes** de entropía opaca. Su origen y verificación los define ADR 0002.

```
r      = (primeros 7 bytes big-endian) >> 4            // 52 bits, r ∈ [0, 2⁵²)
E      = 2⁵²
raw    = ⌊(10_000 − houseEdgeBps) · E / (100 · (E − r))⌋   // centésimas
crash  = min(max(raw, 100) · 100, maxMultiplier)          // diezmilésimas, múltiplo de 100
```

Parámetros:
- `houseEdgeBps ∈ [0, 10_000)`. *Propuesto:* `300`.
- `maxMultiplier`: múltiplo de 100 en `[1.01x, 1_000_000x]`. *Propuesto:* `100x`, pendiente de fijarse junto con los límites de exposición.

Propiedades (demostradas en §8 y probadas):
- Para cualquier objetivo `m` con precisión de centésimas y `1.01x ≤ m ≤ maxMultiplier`: `P(crash ≥ m) = ⌊(10_000 − edge) · E / (10_000 · m_centi)⌋ / E`. Es decir, `(1 − edge)/m` con un error menor que `2⁻⁵²`.
- En consecuencia, el **RTP de cualquier estrategia de objetivo fijo es `1 − edge`** (97 % con la propuesta), con un error `≤ m · 2⁻⁵²`.
- `P(crash < 1.01x) = 1 − (1 − edge)/1.01 ≈ 3.96 %`. Dentro de esa cifra, `P(raw < 1.00x) = edge` (3 %) corresponde a las rondas limitadas a 1.00x.
- El límite `maxMultiplier` no altera el RTP de los objetivos `≤ maxMultiplier`, porque el cap solo afecta a rondas que ya habrían superado cualquier objetivo admitido.

## 6. Liquidación

### 6.1 Regla única de victoria

> Un cash-out con multiplicador reconocido `m` **gana si y solo si `m ≤ crashPoint`** y `m ≥ 1.01x`. Paga `payout(stake, m)`. Una apuesta sin cash-out ganador pierde su stake.

- **Manual:** la solicitud de cash-out se reconoce en el tick autoritativo `t`, que fija la autoridad de settlement y no el orden de llegada a un servidor, y usa `m = reconocido(t)`.
  - Gana si y solo si `t < crashTick(crashPoint)`, lo que equivale a `reconocido(t) ≤ crashPoint`.
  - Una solicitud con `reconocido(t) < 1.01x` se **ignora** (`below-minimum-multiplier`) y la apuesta sigue activa.
- **Automático:** con objetivo `T`, gana si y solo si `T ≤ crashPoint` y paga exactamente `T`. Se considera disparado en `autoTick(T)`, el primer tick con `reconocido ≥ T`.
- **Varios candidatos en la misma apuesta:** gana el de menor tick. Si hay empate de tick, **el automático precede al manual**.
  - Varias solicitudes manuales o duplicadas son idempotentes: solo cuenta la de menor tick.
- Se ignoran, con motivo tipado, las solicitudes con tick inválido (negativo o no entero, `invalid-tick`) y las dirigidas a apuestas inexistentes (`unknown-bet`).
  - La lista de ignoradas se ordena canónicamente por `(betId, tick, reason)`.
- **El resultado no depende del orden de entrada** de las solicitudes.

### 6.2 `settleRound(bets, cashOuts, crashPoint, curve)`

Devuelve, por apuesta y en el orden de entrada de las apuestas, `cashed-out` (con multiplicador y pago) o `lost` (pago 0). Incluye además los totales de stake y de pago y las solicitudes ignoradas. Rechaza entradas estructuralmente inválidas con `RangeError`. Esas entradas deberían haberse filtrado antes con `placeBet`. Son entradas inválidas:
- ids de apuesta duplicados;
- stakes negativos;
- objetivos de auto cash-out sin precisión de centésimas o fuera de `[1.01x, maxMultiplier]`;
- un crash point fuera de rango.

### 6.3 `refundRound(bets)` — ronda `voided`

Cada apuesta se reembolsa por su stake exacto.

### 6.4 `settleForfeitedRound(bets, cashOuts, curve)` — ronda `forfeited`

Se liquida como `settleRound` con `crashPoint = maxMultiplier`, y las apuestas que no cobraron se **reembolsan** en vez de perderse.

- Invariante: para cualquier crash point `c`, el pago total del forfeit es mayor o igual que el de `settleRound(…, c)`.
- Consecuencia: no revelar nunca beneficia al house (ADR 0002).

## 7. Límites

Son por activo (`BetLimits`): `minStake ≥ 1`, `maxStake ≥ minStake`, `maxPayout` y `maxRoundExposure`.

- **Exposición de una apuesta:** `payout(stake, T ?? maxMultiplier)`, donde `T` es el objetivo de auto cash-out.
  - Acota su pago máximo posible en cualquier liquidación, incluido el forfeit.
- `validateBet` rechaza, en este orden y con motivo tipado:
  1. `stake-below-minimum`
  2. `stake-above-maximum`
  3. `auto-cash-out-not-centi-precise`
  4. `auto-cash-out-below-minimum` (`T < 1.01x`)
  5. `auto-cash-out-above-maximum` (`T > maxMultiplier`)
  6. `payout-above-maximum` (exposición `> maxPayout`)
- `placeBet` además rechaza:
  - `betting-closed`, si la fase no es `betting`;
  - `duplicate-bet`, si el id está repetido;
  - `round-exposure-exceeded`, si la suma de exposiciones supera `maxRoundExposure`.
- Estos controles deben aplicarse en el punto autoritativo (ADR 0001). La UI solo los refleja.
- *Decisión abierta:* en lugar de limitar el stake de las apuestas sin auto cash-out por `stake · maxMultiplier ≤ maxPayout`, forzar un cash-out automático al alcanzar `maxPayout`. El MVP usa la primera opción.
- *Pendiente:* los valores concretos de los límites por activo. Dependen del tamaño del house bank.

## 8. Justificación matemática del RTP

Sea `A = (10_000 − edge) · E` y un objetivo `k` en centésimas (`101 ≤ k ≤ max`).

- Se cumple `raw ≥ k ⇔ A / (100(E − r)) ≥ k ⇔ E − r ≤ ⌊A / (100k)⌋`.
- `r` es uniforme en `[0, E)`, y `E − r` toma cada valor de `[1, E]` exactamente una vez. Por tanto `P(raw ≥ k) = min(E, ⌊A/(100k)⌋) / E`.
- Como `k ≥ 101`, se tiene `⌊A/(100k)⌋ < E`.
- El pago esperado por unidad apostada es `k/100 · P = (1 − edge/10_000) − ε`, con `0 ≤ ε < k / (100 · E)`.
- Para `k ≤ max`, el cap no cambia el evento `crash ≥ k`.

Las pruebas comprueban esta igualdad de forma exacta con aritmética `bigint`: encuentran el umbral de `r` y verifican que el crash point cambia exactamente en él. No usan Monte Carlo.

## 9. Invariantes (criterios de aceptación)

Todos están cubiertos por pruebas en `src/games/crash/domain/*.test.ts`:

1. **Curva:** `m₀ = 1.0000x`; es estrictamente creciente; `crashTick(c)` es el primer tick con `reconocido > c`.
2. **Crash point:**
   - el resultado es un múltiplo de 100 en `[1.00x, maxMultiplier]`;
   - para `r = 0` da `1.00x` y para `r = 2⁵² − 1` da `maxMultiplier`;
   - una entropía de longitud distinta de 32 bytes se rechaza;
   - el RTP es exacto según §8.
3. **Pago acotado:** cada pago es `0` o está en `[stake, exposición]`, y la suma de pagos es menor o igual que la suma de exposiciones.
4. **Regla única:** todo cash-out pagado cumple `1.01x ≤ m ≤ crashPoint`; todo auto con `T ≤ crashPoint` cobra como mucho `T`.
5. **Determinismo:** permutar las solicitudes de cash-out no cambia la liquidación.
6. **Idempotencia:** duplicar solicitudes no cambia la liquidación.
7. **Monotonía para el jugador:** con un crash point mayor, el pago de cada apuesta no disminuye.
8. **Forfeit:** su pago total es mayor o igual que el de cualquier revelación.
9. **Void:** reembolsa exactamente la suma de stakes.
10. **Límites:** bordes exactos (±1 unidad base, ±1 centésima) y exposición de ronda.
11. **Ciclo de vida:** solo las transiciones de §3 son válidas; no se aceptan apuestas fuera de `betting`.

## 10. Decisiones abiertas

| # | Decisión | Dónde se decide |
| --- | --- | --- |
| 1 | Autoridad de settlement y duración del tick | ADR 0001 |
| 2 | Fuente de entropía, compromiso y timeouts | ADR 0002 |
| 3 | `houseEdgeBps` (propuesto 300), `growthPpm` (propuesto 24_000), `maxMultiplier` (propuesto 100x) | Esta spec, tras revisar riesgo |
| 4 | Valores de `BetLimits` por activo | Spec del house bank (pendiente) |
| 5 | Apuestas durante `running` | Producto |
| 6 | Cash-out forzado al alcanzar `maxPayout` | Producto + riesgo |
