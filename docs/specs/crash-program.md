# Spec — Programa on-chain de Crash (Solana / Anchor)

- Estado: **aprobada v1.1** (2026-09-28). v1.1 integra Switchboard On-Demand (ADR 0002 aceptado); todas las decisiones de la §12 están resueltas. La implementación vive en `programs/solana/`.
- Fecha: 2026-09-28
- Decisiones: [ADR 0001](../adr/0001-settlement-authority.md) (aceptado: programa Anchor, tick = slot) y [ADR 0002](../adr/0002-randomness-source.md) (aceptado: esquema C con Switchboard On-Demand y authority PDA; datos en el [spike](../spikes/vrf-devnet.md)).
- Reglas: [`crash-round-rules.md`](crash-round-rules.md) v1. Vectores de referencia: [`vectors/crash-rules-v1.json`](vectors/crash-rules-v1.json).
- Red: **solo devnet**. Pasar a mainnet exige revisión legal, de riesgo y de seguridad, además de una auditoría externa.
- **Sustituida por [v2](crash-program-v2.md)** (ADR 0003: cuentas de jugador, monedas y sesiones), implementada y desplegada en devnet el 2026-09-29. Esta v1.1 queda como histórico del programa retirado `384Cf…`; v2 solo describe lo que cambia, así que lo que v2 no menciona sigue definido aquí.

## 1. Alcance

**v1 del programa:**
- **Activo:** solo **SOL**.
- **House bank:** uno solo, financiado por el admin.
- **Rondas:** una ronda activa a la vez.
- **Apuestas:** una por jugador y ronda.
- **Autoridad:** el programa es la autoridad de apuestas, cash-outs y liquidación, y aplica exactamente las reglas v1.

**Fuera de v1** (§11):
- USDC/SPL;
- varias apuestas por jugador y ronda;
- financiadores externos del bank;
- mainnet (el program id de Switchboard está fijado al de devnet).

## 2. Diferencias con el motor TypeScript

| Motor (`src/games/crash/domain`) | Programa |
| --- | --- |
| `Bet.id` arbitrario | Una apuesta por `(round_id, player)`; el id es la PDA |
| Solicitudes inválidas → `ignored` | Se **rechazan al enviarse**. Por ejemplo, un cash-out por debajo de 1.01x o fuera del horizonte devuelve un error. El efecto económico es el mismo |
| `settleRound` liquida todas las apuestas de golpe | `settle_bet` liquida una apuesta por transacción, con la misma función por apuesta |
| Importes y multiplicadores `bigint` | `u64`, con productos intermedios en `u128` y aritmética comprobada |
| `crashPointFromEntropy(32 bytes)` | La misma función. La entropía se calcula on-chain (§6) |

La lógica pura (curva, crash point, liquidación de una apuesta y validación de límites) vive en un módulo Rust **sin dependencias de Anchor**. Sus pruebas unitarias consumen `crash-rules-v1.json` y deben reproducirlo exactamente.

## 3. Cuentas

Todas son PDAs del programa salvo la cuenta de randomness, que pertenece a Switchboard.

| Cuenta | Seeds | Campos principales |
| --- | --- | --- |
| `HouseConfig` | `["house"]` | `admin`, `operator`, `rules_version: u16`, `limits { min_stake, max_stake, max_payout, max_round_exposure }` en lamports, `max_bets_per_round: u32`, `timeouts { betting_slots, entropy_timeout_slots, reveal_grace_slots }`, `paused: bool`, `next_round_id: u64`, `current_round: Option<u64>`, `randomness_account: Pubkey` (`default` = sin configurar), bumps (incluido el de la authority de randomness) |
| `HouseVault` | `["vault"]` | Contiene los lamports del bank y de los stakes. `reserved_exposure: u64` es la suma de las exposiciones de las apuestas activas |
| Authority de randomness | `["randomness_authority"]` | Sin datos. Es la `authority` de la cuenta de randomness de Switchboard; solo el programa puede firmar con ella (CPI) |
| `Round` | `["round", round_id_le]` | `round_id`, `rules_version`, `phase`, `commit: [u8;32]`, `opened_slot`, `betting_end_slot`, `entropy_deadline_slot`, `randomness_account: Pubkey`, `randomness_seed_slot: u64` (fijados en `close_betting`), `start_slot`, `reveal_deadline_slot`, `vrf_output: [u8;32]`, `seed: [u8;32]` (tras revelar), `crash_point: u64`, `crash_tick: u64`, `total_exposure`, `bet_count`, `settled_count` |
| `Bet` | `["bet", round_id_le, player]` | `round_id`, `player`, `stake`, `auto_cash_out: u64` (0 = sin auto), `exposure`, `cash_out_tick: Option<u64>`, `status: Active \| Settled`, `outcome`, `payout` |
| Randomness (Switchboard) | Keypair, creada por CPI | Owner = program id de Switchboard fijado. 480 bytes: discriminador, `authority`, `queue`, `seed_slothash`, `seed_slot`, `oracle`, `reveal_slot`, `value`, … (IDL fijado en `programs/solana/programs/crash/tests/fixtures/`). Una por casa; se reutiliza en cada ronda |

- Las cuentas `Round` **no se cierran**, porque conservan los datos públicos que necesita el verificador (ADR 0002).
- Las cuentas `Bet` pueden cerrarse después de liquidarse, y el rent vuelve al jugador.

## 4. Correspondencia con las reglas

- **Tick:** `tick = slot_actual − start_slot`. `start_slot` es el slot en que se ejecuta `start_round`, que es el tick 0.
- **Horizonte:** la curva v1 tiene 196 ticks (0…195). Un `cash_out` con `tick ≥ 196` se rechaza (`RoundHorizonExceeded`).
- **Reconocido:** `recognized(tick) = ⌊curve[tick] / 100⌋ · 100`. `cash_out` exige `recognized ≥ 1.01x` (`CashOutTooEarly`).
- **Exposición:** `payout(stake, auto ?: maxMultiplier)`. Se reserva en `place_bet` y se libera en `settle_bet`.
- **Liquidación de una apuesta**, idéntica a `settleRound` restringida a esa apuesta:
  - el auto gana si `auto ≤ crash_point` y se considera disparado en `autoTick`;
  - el manual gana si `cash_out_tick < crash_tick`;
  - si ganan los dos, se elige el de menor tick, y en caso de empate el auto;
  - `payout = ⌊stake · m / 10_000⌋`.
- **Forfeit:** se liquida con `crash_point = maxMultiplier`, y si la apuesta pierde se reembolsa.
- **Void:** reembolso del stake.

## 5. Instrucciones

Notación: **S** = firmante requerido; **P** = sin permisos (cualquiera puede llamarla).

| Instrucción | Quién | Precondiciones | Efectos |
| --- | --- | --- | --- |
| `initialize_house(operator, limits, timeouts, max_bets)` | S: `admin` (pagador), que debe ser la **autoridad de upgrade** del programa (se comprueba vía `ProgramData`); así nadie puede adelantarse y quedarse con el rol de admin | `HouseConfig` no existe; límites válidos (§7 de las reglas) | Crea `HouseConfig` y `HouseVault` (rent-exempt); `rules_version = 1` |
| `update_config(...)` | S: `admin` | Límites válidos; `rules_version` solo cambia si no hay ronda activa | Actualiza operador, límites, timeouts o pausa. No afecta a las apuestas ya aceptadas |
| `deposit_bank(amount)` | S: `admin` | `amount > 0` | Transfiere lamports al vault |
| `withdraw_bank(amount)` | S: `admin` | `vault.lamports − amount − rent_min ≥ reserved_exposure` | Transfiere lamports del vault al admin |
| `create_randomness_account(recent_slot)` | S: `admin` (pagador) y el keypair nuevo de la cuenta de randomness | No hay ronda activa; programa de Switchboard = el fijado | CPI de `randomness_init` firmada por la authority PDA. Después verifica owner, discriminador y `authority = PDA`, y guarda la cuenta en `HouseConfig`. Sirve también para rotarla |
| `open_round(commit)` | S: `operator` | `!paused`; no hay ronda activa (o está en fase terminal); `commit ≠ 0`; cuenta de randomness configurada | Crea `Round(next_round_id)` en `Betting`; `betting_end_slot = slot + betting_slots`; incrementa `next_round_id` |
| `place_bet(stake, auto)` | S: `player` (pagador) | `!paused`; fase `Betting`; `slot < betting_end_slot`; `validateBet` pasa; `bet_count < max_bets`; `total_exposure + exposure ≤ max_round_exposure`; el vault puede cubrirla (`lamports − rent_min ≥ reserved + exposure`, contando el stake entrante); `Bet` no existe (`init`) | Transfiere el stake jugador → vault (CPI al System Program); crea `Bet`; `reserved_exposure += exposure`; `total_exposure += exposure` |
| `close_betting()` | P | Fase `Betting`; `slot ≥ betting_end_slot`; cuenta de randomness = la de `HouseConfig`; programa de Switchboard = el fijado | CPI de `randomness_commit` (el llamante elige un oráculo de la cola; Switchboard valida la relación). Tras la CPI exige `betting_end_slot − 1 ≤ seed_slot < slot`. Guarda `randomness_account` y `randomness_seed_slot`; `entropy_deadline_slot = slot + entropy_timeout_slots`; → `AwaitingEntropy` |
| `start_round(signature, recovery_id, value)` | P (el llamante paga como `payer` del reveal) | Fase `AwaitingEntropy`; `slot ≤ entropy_deadline_slot`; cuenta de randomness = `round.randomness_account`; programa de Switchboard = el fijado | CPI de `randomness_reveal` con el payload público del gateway, firmada por la authority PDA. Tras la CPI lee la cuenta (owner, discriminador, `authority = PDA`) y exige `seed_slot = round.randomness_seed_slot` y `reveal_slot = slot`. Guarda `vrf_output = value` leído de la cuenta; `start_slot = slot`; `reveal_deadline_slot = start_slot + 196 + reveal_grace_slots`; → `Running` |
| `cash_out()` | S: `player` | Fase `Running`; la `Bet` es del firmante y está `Active` sin `cash_out_tick`; `tick < 196`; `recognized(tick) ≥ 1.01x` | Registra `cash_out_tick = tick`. No paga todavía: el crash point aún es secreto |
| `reveal(seed)` | P | Fase `Running`; `H(tag_commit ‖ program_id ‖ round_id ‖ seed) = commit`; con el crash point derivado, `slot − start_slot ≥ crash_tick`; `slot ≤ reveal_deadline_slot` (después solo aplica `forfeit_round`, así el resultado nunca depende de una carrera) | Calcula `entropy`, `crash_point` y `crash_tick`; guarda `seed`; → `Crashed` |
| `settle_bet()` | P | Fase `Crashed`, `Forfeited` o `Voided`; `Bet` `Active`; la cuenta de destino es `bet.player` | Calcula el resultado (§4); paga vault → jugador; `reserved_exposure −= exposure`; `Settled`; `settled_count += 1`. Si `settled_count = bet_count` y la fase es `Crashed` → `Settled` |
| `void_round()` | S: `operator` en `Betting`; P en `Betting` con `slot > betting_end_slot + entropy_timeout_slots` (ronda atascada: nadie ejecutó `close_betting` o su commit falla); P en `AwaitingEntropy` con `slot > entropy_deadline_slot` | Nadie conoce todavía el resultado | → `Voided` |
| `forfeit_round()` | P | Fase `Running`; `slot > reveal_deadline_slot` | → `Forfeited` |
| `close_bet()` | P | `Bet` `Settled` | Cierra la cuenta; el rent va a `bet.player` |

**Reveal:** exigir `tick ≥ crash_tick` impide revelar antes de que la curva alcance el crash point. Una revelación temprana cerraría la ronda y privaría a los jugadores de cash-outs ganadores. Con esta regla, **una revelación nunca bloquea un cash-out ganador**: cualquier cash-out posterior tendría `tick ≥ crash_tick` y perdería igualmente.

**Pausa:** solo bloquea `open_round` y `place_bet`. **Nunca** bloquea las vías de salida: `cash_out`, `reveal`, `settle_bet`, `void_round`, `forfeit_round` y `close_bet`.

**Eventos (Anchor `emit!`):** `RoundOpened`, `BetPlaced`, `BettingClosed`, `RoundStarted`, `CashOutRecorded`, `RoundRevealed`, `BetSettled`, `RoundVoided`, `RoundForfeited`, `BankDeposited`, `BankWithdrawn`. Son la fuente de las proyecciones off-chain; estas deben poder reconstruirse desde los eventos y desde las cuentas `Round`.

## 6. Randomness (ADR 0002, esquema C)

```
commit  = SHA256("crash/v1/commit"  ‖ program_id ‖ round_id_le ‖ seed)
entropy = SHA256("crash/v1/entropy" ‖ program_id ‖ round_id_le ‖ seed ‖ vrf_output)
crash_point = crashPointFromEntropy(entropy, CRASH_RULES_V1)
```

- SHA-256 se calcula con el syscall de Solana (`hashv`).
- El `commit` incluye `round_id` y `program_id`, así que no puede reutilizarse en otra ronda ni en otro despliegue: la verificación fallaría.
- La semilla `seed` se genera y guarda off-chain por el operador. Nunca se registra en logs ni se transmite antes de `reveal`.

### 6.1 `vrf_output` con Switchboard On-Demand

```
create_randomness_account : CPI randomness_init   (authority = PDA ["randomness_authority"])
close_betting             : CPI randomness_commit (firma la PDA) → Round.randomness_account, Round.randomness_seed_slot
start_round               : CPI randomness_reveal (firma la PDA; payload del gateway) → lectura en el mismo slot → vrf_output
```

- **Program id de Switchboard fijado** en el código (devnet `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2`). Toda CPI comprueba que la cuenta de programa recibida es esa. Mainnet exige un cambio de código deliberado.
- **Nadie salvo el programa puede hacer commit o reveal** en la cuenta de la casa, porque Switchboard exige la firma de la authority y esta es una PDA. En particular, el operador no puede revelar `e` por su cuenta y decidir si empieza la ronda.
- **Vinculación a la ronda:**
  - `close_betting` guarda la cuenta y el `seed_slot` del commit que acaba de hacer; exige `betting_end_slot − 1 ≤ seed_slot < slot`, así que el commit es posterior al cierre de apuestas (medido en devnet: `seed_slot = slot − 1`);
  - `start_round` exige que la cuenta siga comprometida con ese mismo `seed_slot` y que `reveal_slot = slot` (el valor se acaba de revelar en esta instrucción). Un valor de un commit anterior no puede usarse.
- **Lectura de la cuenta:** owner = Switchboard, discriminador `RandomnessAccountData`, longitud ≥ 184 bytes y `authority = PDA`. `vrf_output` se toma de la cuenta tras la CPI, no del argumento.
- **Lo que verifica Switchboard, no el programa:** la firma secp256k1 del oráculo sobre el valor, que el oráculo y la cola correspondan a la cuenta, y las cuentas auxiliares del reveal (`stats`, `reward_escrow`, `program_state`…). El programa las pasa sin interpretarlas.
- **Compute units medidas en devnet con el programa desplegado:** `close_betting` 27 775–28 057, `start_round` 98 605–103 105 y `create_randomness_account` 113 276. Todas caben en el límite por defecto de 200 000 CU (en solitario, Switchboard gasta 15 109 en el commit y 41 934 en el reveal).

## 7. Invariantes (cada uno con pruebas)

1. **Solvencia:** después de cada instrucción, `vault.lamports − rent_min ≥ reserved_exposure`.
2. **Contabilidad:** `reserved_exposure = Σ exposure` de las `Bet` activas.
3. **Una sola liquidación:** cada `Bet` se liquida como mucho una vez, y su pago coincide con el del motor para la misma entrada.
4. **Un solo cash-out:** `cash_out_tick` se fija como mucho una vez, solo en `Running` y solo con `recognized ≥ 1.01x`.
5. **Revelación correcta:** solo se acepta con un compromiso válido y cuando `tick ≥ crash_tick`.
6. **Transiciones:** las fases siguen exactamente §3 de las reglas.
7. **Destino de los fondos:** las instrucciones sin permisos solo pueden mover fondos hacia `bet.player`; `withdraw_bank` nunca invade `reserved_exposure`.
8. **Salida siempre disponible:** la pausa nunca bloquea las vías de salida.
9. **Forfeit y void:** coinciden con `settleForfeitedRound` y `refundRound` del motor.
10. **Equivalencia con el motor:** la lógica pura en Rust reproduce `crash-rules-v1.json` (curva, crash points, liquidaciones y validación).

## 8. Validación de cuentas y firmantes (checklist de seguridad)

| Instrucción | Signer | Validaciones de cuenta |
| --- | --- | --- |
| `initialize_house` | admin | `HouseConfig` y `HouseVault` con `init` + seeds + bump; `program.programdata_address() = program_data` y `program_data.upgrade_authority_address = admin` |
| `update_config`, `deposit_bank`, `withdraw_bank` | admin | `has_one = admin` en `HouseConfig`; vault con seeds + bump; destino del retiro = `admin` |
| `open_round` | operator | `has_one = operator`; `Round` con `init` y seeds `round_id = next_round_id` |
| `place_bet` | player | `Round` con seeds + fase; `Bet` con `init` y seeds `(round_id, player)`; System Program verificado |
| `create_randomness_account` | admin + keypair de la cuenta nueva | `has_one = admin`; authority PDA con seeds + bump; programa de Switchboard con `address` fijado; tras la CPI, owner, discriminador y `authority` de la cuenta creada |
| `close_betting` | — (P) | `Round` con seeds; `randomness = config.randomness_account`; authority PDA con seeds + bump; programa de Switchboard y sysvar `SlotHashes` con `address` fijado; cola y oráculo los valida Switchboard |
| `start_round` | `payer` (cualquiera) | `Round` con seeds; `randomness = round.randomness_account`; authority PDA con seeds + bump; programa de Switchboard y programas/sysvars del reveal con `address` fijado; tras la CPI, owner, discriminador, `authority`, `seed_slot` y `reveal_slot` |
| `void_round`, `forfeit_round` | — (P) | `Round` con seeds; `HouseConfig` con seeds |
| `cash_out` | player | `Bet` con seeds `(round_id, signer)` y `has_one = player` |
| `reveal` | — (P) | `Round` con seeds; el compromiso verifica la semilla |
| `settle_bet`, `close_bet` | — (P) | `Bet` con seeds; `player` mutable con `address = bet.player`; vault con seeds + bump |

Reglas generales:
- Anchor verifica owner y discriminador en todas las cuentas tipadas.
- Nunca se usa `UncheckedAccount` sin documentar su validación manual.
- `overflow-checks = true` en el perfil `release`.
- Sin CPIs a programas no verificados. Solo se permiten el System Program y Switchboard On-Demand, con su id fijado.
- Las cuentas auxiliares de Switchboard son `UncheckedAccount` documentadas: el programa no las lee ni les transfiere nada; las valida Switchboard.

## 9. Amenazas

| Amenaza | Mitigación |
| --- | --- |
| Cuentas falsificadas o sustituidas | Seeds + bump, owner, `has_one` y `address` en cada cuenta (§8) |
| Pago a otra cuenta | El destino del pago está fijado a `bet.player` |
| Doble cash-out o doble liquidación | Campos de estado de una sola escritura; transacciones atómicas |
| Replay de transacciones | Blockhash reciente, más la máquina de estados, que impide aplicar dos veces un efecto |
| Reutilizar un compromiso o una entropía | `round_id` y `program_id` dentro de los hashes |
| Revelar antes de tiempo para cortar cash-outs | Requisito `tick ≥ crash_tick` en `reveal` |
| No revelar | `forfeit_round` sin permisos tras el deadline (ADR 0002) |
| Fallo del VRF | `void_round` sin permisos tras `entropy_deadline_slot` |
| El operador conoce `e` antes que nadie y no empieza la ronda | Authority de randomness = PDA; solo `start_round` (sin permisos) puede revelar |
| Programa de Switchboard falso en la CPI | `address` fijado a la cuenta de programa |
| Cuenta de randomness falsa o de otra casa | Dirección = `HouseConfig`/`Round`; owner, discriminador y `authority = PDA` comprobados tras cada CPI |
| Reutilizar un valor revelado de un commit anterior | `seed_slot` guardado en `close_betting` y `reveal_slot = slot` en `start_round` |
| Ronda atascada en `Betting` (nadie cierra o el commit falla) | `void_round` sin permisos tras `betting_end_slot + entropy_timeout_slots` |
| Quien cierra las apuestas elige un oráculo caído | Solo liveness: `void` con reembolso íntegro tras el timeout; el crank del operador cierra en cuanto se puede |
| Reentrada vía CPI | Sin CPIs a programas arbitrarios; el estado se actualiza antes de transferir |
| Desbordamiento aritmético | `u128` + operaciones comprobadas + `overflow-checks` |
| Insolvencia | Reserva de exposición en `place_bet`; `withdraw_bank` limitado |
| DoS por número de apuestas | `max_bets_per_round`; liquidación por apuesta y sin permisos (el operador ejecuta un *crank*, pero cualquiera puede hacerlo) |
| Retraso de inclusión o congestión | El cash-out se reconoce por el slot de inclusión; la UI lo advierte y el auto cash-out es inmune |
| Compromiso de la clave del operador | Puede abrir y revelar rondas, pero no mover fondos ni elegir resultados |
| Compromiso de la clave del admin | Puede retirar el bank disponible (nunca la parte reservada) y cambiar límites futuros |
| Compromiso de la autoridad de upgrade | Control total. En devnet se usa una clave local; antes de mainnet, multisig + timelock (decisión abierta) |

## 10. Pruebas previstas

- **Rust, lógica pura:** reproducción exacta de `crash-rules-v1.json`, más pruebas de propiedades (`proptest`) de los mismos invariantes que en TypeScript.
- **LiteSVM, instrucciones:**
  - flujo completo con `warp_to_slot`: apostar, cerrar, iniciar, cash-outs en distintos ticks, revelar y liquidar;
  - void y forfeit por timeout;
  - todos los errores de precondición.
- **Adversariales:**
  - cuentas sustituidas, firmante incorrecto y pago a otra cuenta;
  - doble liquidación y doble cash-out;
  - reveal temprano, reveal con semilla incorrecta y reveal de otra ronda;
  - retiro que invade la reserva;
  - pausa con vías de salida.
- **Invariante 1** comprobado tras cada instrucción en todas las pruebas.
- **Switchboard:**
  - los builders de las CPIs coinciden con el IDL on-chain fijado (discriminadores, orden de cuentas, signer y writable);
  - el parser lee una cuenta real de devnet;
  - LiteSVM carga un **mock de Switchboard solo para pruebas** en el program id de devnet. Implementa `randomness_init/commit/reveal` con el mismo IDL y las mismas comprobaciones de authority, pero **no verifica la firma del oráculo** (el valor revelado lo elige la prueba). Nunca se despliega;
  - adversariales: cuenta de randomness ajena o con owner falso, programa de Switchboard falso, `seed_slot` de otro commit, reveal tras el deadline, doble `start_round`.
- **Lo que las pruebas locales no cubren:** la verificación real de la firma del oráculo y la compatibilidad con el programa de Switchboard desplegado. Se cubren con una prueba end-to-end en devnet.

## 11. Fases posteriores (anotadas, no implementadas)

- **USDC (SPL Token):**
  - vault como token account propiedad de la PDA del vault;
  - CPIs a Token Program con mint y programa verificados;
  - límites por activo (6 decimales);
  - `HouseConfig` por activo o un vault por mint.
- **Varias apuestas por jugador:** seeds con un índice por jugador.
- **Financiadores externos del bank:** cambian el modelo de confianza (colusión, ADR 0002).

## 12. Decisiones

Aprobadas el 2026-09-28.

| # | Decisión | Resolución |
| --- | --- | --- |
| 1 | Proveedor VRF y forma de la solicitud y la lectura | **Switchboard On-Demand** con authority PDA, commit en `close_betting` y reveal en `start_round`, ambos sin permisos (ADR 0002, decisión final; §6.1) |
| 2 | Timeouts en slots | `betting_slots = 25` (≈10 s), `entropy_timeout_slots = 150` y `reveal_grace_slots = 150`. Son valores iniciales configurables en `HouseConfig` |
| 3 | `max_bets_per_round` | 256 en devnet |
| 4 | Comisiones de `settle_bet`, `close_betting`, `start_round` y `reveal` | Las paga un *crank* del operador. Las instrucciones siguen sin permisos como respaldo |
| 5 | Priority fees de los cash-outs | Las paga el jugador; la UI sugiere un valor |
| 6 | Autoridad de upgrade antes de mainnet | Multisig + timelock (requisito previo a mainnet) |
| 7 | Ubicación del workspace | `programs/solana/`, un workspace con `Anchor.toml` propio y fuera de `src/` |

## 13. Estado de la implementación (2026-09-28)

- `programs/solana/crates/crash-rules`: la lógica pura reproduce `crash-rules-v1.json` exactamente y tiene pruebas de propiedades.
- `programs/solana/programs/crash`: están implementadas **todas** las instrucciones de §5, incluidas `create_randomness_account`, la CPI de commit en `close_betting` y la de reveal en `start_round` (§6.1). El adaptador de Switchboard es `src/switchboard.rs`.
- Pruebas:
  - LiteSVM: flujo completo commit → reveal → cash-outs → revelación → liquidación, forfeit, void (por timeout de entropía y por ronda atascada en `Betting`), límites, solvencia comprobada tras cada transacción, inicio de la casa reservado a la autoridad de upgrade, pausa con las vías de salida abiertas y adversariales (pago a otra cuenta, cash-out ajeno, doble liquidación, reveal temprano o con semilla falsa, cuenta de randomness ajena, programa de Switchboard falso, reveal sin valor en el slot, `seed_slot` de otro commit, reveal tras el deadline, doble `start_round`, creación de la cuenta por un tercero o con ronda activa);
  - adaptador: IDL on-chain fijado y cuenta real de devnet (`tests/switchboard.rs`).
- Ya no hay atajo de pruebas para llegar a `Running`: las pruebas pasan por `start_round` con el mock de Switchboard (`test-programs/switchboard-mock`, nunca desplegable: su `declare_id!` es el de Switchboard).
- Compute units en LiteSVM con el mock: `close_betting` 15 091 y `start_round` 58 062. En devnet, con el Switchboard real, son ~28 000 y ~100 000 (§6.1).
- **Verificado en devnet** (programa desplegado, [spike fase 3](../spikes/vrf-devnet.md)):
  - 23 rondas completas contra el Switchboard real, con crash point y pago idénticos a un verificador independiente;
  - Switchboard rechaza que el operador revele por su cuenta;
  - 2 rondas anuladas por caídas del gateway de Switchboard, con reembolso íntegro.
- **Decisión abierta:** ampliar `entropy_timeout_slots` (hoy 150) para reducir anulaciones por caídas del gateway. Es un parámetro de `HouseConfig`.
- Pendiente antes de mainnet (además de §12.6): auditoría externa, fuzzing de instrucciones, program id de Switchboard de mainnet y repetir la medición del spike en mainnet.
