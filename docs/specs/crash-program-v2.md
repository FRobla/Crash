# Spec — Programa on-chain de Crash v2 (cuentas de jugador y sesiones)

- Estado: **aprobada v2.0** (2026-09-29): el usuario aprueba las decisiones de la §14. **Implementada** en `programs/solana/`, probada en LiteSVM y **desplegada en devnet** el 2026-09-29, con prueba end-to-end contra el Switchboard real (§15).
- Fecha: 2026-09-29
- Parte de la [spec v1.1](crash-program.md), que describe el programa desplegado hoy en devnet. Esta spec **solo describe lo que cambia**. Todo lo que no se menciona aquí sigue igual que en v1.1: randomness y Switchboard (§6 y §6.1), fases y rondas, `reveal`, `void_round`, `forfeit_round`, house bank y timeouts. Es la spec vigente desde su despliegue (2026-09-29); v1.1 queda como histórico del programa retirado `384Cf…`.
- Decisiones: [ADR 0001](../adr/0001-settlement-authority.md), [ADR 0002](../adr/0002-randomness-source.md) y [ADR 0003](../adr/0003-player-accounts-and-sessions.md) (aceptado: saldo on-chain en `Player`, monedas, claves de sesión, nombre y experiencia on-chain).
- Reglas: [`crash-round-rules.md`](crash-round-rules.md) v1, **sin cambios**. Los vectores `crash-rules-v1.json` y el crate `crash-rules` tampoco cambian.
- Red: **solo devnet**.

## 1. Alcance

**Cambia respecto a v1.1:**
- el stake sale del saldo del jugador en su PDA `Player`, no de su wallet;
- el pago vuelve a ese saldo, no a la wallet;
- la apuesta en curso vive dentro de `Player`; desaparecen la cuenta `Bet` y `close_bet`;
- apuestas y cash-outs se pueden firmar con una **clave de sesión** acotada;
- hay nombre de usuario on-chain y único;
- hay contadores de experiencia on-chain.

**Sin cambios:** activo SOL, un house bank, una ronda activa a la vez, una apuesta por jugador y ronda, reglas v1.

**Fuera de v2:**
- ventajas por nivel: función de nivel (`PROGRESSION_V1`) y beneficios; tendrán su propia spec;
- USDC: saldos separados por activo (ADR 0003), en una fase posterior;
- chat y base de datos (ADR aparte);
- varias apuestas por jugador y ronda.

## 2. Unidades

- **Todo importe on-chain está en lamports**, igual que en v1.1.
- **Moneda** = 10⁶ lamports (1 SOL = 1000 monedas). La moneda solo existe en la UI: se muestra con 6 decimales y su unidad base es 1 lamport. El programa nunca convierte entre unidades.
- `total_wagered` también está en lamports. La experiencia (XP) es `total_wagered` expresada en monedas y la calcula la función de progresión (fuera de v2).

## 3. Cuentas

### 3.1 Nuevas

| Cuenta | Seeds | Campos |
| --- | --- | --- |
| `Player` | `["player", owner]` | `owner: Pubkey`, `username: Username` (§3.3), `username_changed_slot: u64`, `balance: u64`, `active_bet: Option<ActiveBet>`, `session: Option<Session>`, `total_wagered: u64`, `bets_settled: u64`, `created_slot: u64`, `bump: u8` |
| `UsernameRecord` | `["username", nombre]` | `owner: Pubkey`, `bump: u8` |

```
ActiveBet { round_id: u64, stake: u64, auto_cash_out: u64 /* 0 = sin auto */, exposure: u64, cash_out_tick: Option<u64> }
Session   { key: Pubkey, expires_slot: u64, spend_cap: u64, spent: u64 }
Username  { len: u8, bytes: [u8; 16] }   // len = 0: sin nombre
```

- **Fondos del jugador:** los lamports de `balance` están **en la propia PDA `Player`**, además de su rent. El vault de la casa nunca los contiene.
- **Tamaños:**
  - `Player`: 197 bytes, rent ≈ 0.00226 SOL;
  - `UsernameRecord`: 41 bytes, rent ≈ 0.00118 SOL;
  - ambos se recuperan con `close_player`.

### 3.2 Modificadas

| Cuenta | Cambio |
| --- | --- |
| `HouseConfig` | Añade `player_policy: PlayerPolicy { max_session_slots: u64, username_cooldown_slots: u64 }`. Se configura con `initialize_house` y `update_config` |
| `Bet` | **Eliminada.** Sustituida por `Player.active_bet` |
| `HouseVault`, `Round` | Sin cambios de layout. `Round.bet_count` y `settled_count` significan lo mismo |

### 3.3 Nombre de usuario

- De 3 a 16 bytes, cada uno en `[a-z0-9_]`. El programa **rechaza** cualquier otro valor (`InvalidUsername`): no normaliza, así que el cliente debe enviar el nombre ya en minúsculas.
- Las seeds de `UsernameRecord` son los bytes exactos del nombre. Así, existir la cuenta equivale a que el nombre esté ocupado.
- `len = 0` significa "sin nombre". Solo ocurre tras `reset_username`; la UI muestra entonces la dirección abreviada.

## 4. Autorización del firmante

Se define **`authorize(player, signer, action)`**:

| Acción | Dueño (`signer = player.owner`) | Clave de sesión (`player.session = Some(s)` y `signer = s.key`) |
| --- | --- | --- |
| `place_bet` | Sí, sin tope | Solo si `slot ≤ s.expires_slot` y `s.spent + stake ≤ s.spend_cap`. Después, `s.spent += stake` |
| `cash_out` | Sí | Sí, **aunque haya caducado**. Un cash-out nunca expone fondos: solo fija la salida de una apuesta que ya existe. Así, si la sesión caduca a mitad de ronda, el jugador no pierde la salida |
| `revoke_session` | Sí | Sí, aunque haya caducado |
| Cualquier otra | Sí, según su tabla (§5) | **No** (`Unauthorized`) |

- La caducidad y el tope de gasto limitan **cuántos fondos se pueden comprometer**, y eso solo ocurre en `place_bet`.
- Ninguna instrucción paga a la clave de sesión salvo `create_session`, que la fondea con lamports de la wallet del dueño.

## 5. Instrucciones

Notación: **S** = firmante requerido; **P** = sin permisos; **O/S** = dueño o clave de sesión según §4.

### 5.1 Jugador

| Instrucción | Quién | Precondiciones | Efectos |
| --- | --- | --- | --- |
| `register_player(username)` | S: `owner` (pagador) | `!paused`; `Player` no existe (`init`); nombre válido (§3.3); `UsernameRecord` no existe (`init`) | Crea `Player` (`balance = 0`, `created_slot = username_changed_slot = slot`) y `UsernameRecord { owner }` |
| `buy_coins(amount)` | S: `owner` | `!paused`; `amount > 0` | CPI de transferencia del System Program owner → PDA `Player`; `balance += amount` |
| `sell_coins(amount)` | S: `owner` | `0 < amount ≤ balance` | `balance −= amount`; mueve lamports `Player` → `owner`. **La pausa no la bloquea.** El destino solo puede ser `owner` |
| `create_session(key, expires_slot, spend_cap, fee_budget)` | S: `owner` | `!paused`; `key ∉ {owner, default}`; `slot < expires_slot ≤ slot + max_session_slots`; `spend_cap > 0` | Sustituye la sesión anterior, si la había, por `Session { key, expires_slot, spend_cap, spent: 0 }`. Si `fee_budget > 0`, CPI de transferencia owner → `key` |
| `revoke_session()` | S: `owner` o la sesión actual (§4) | Existe una sesión | `session = None` |
| `change_username(new)` | S: `owner` (pagador) | Nombre nuevo válido y libre (`init`); `slot ≥ username_changed_slot + username_cooldown_slots`; si hay nombre actual, su `UsernameRecord` se pasa y se cierra (rent → `owner`) | `username = new`; `username_changed_slot = slot` |
| `reset_username()` | S: `admin` | `has_one = admin` en `HouseConfig`; el jugador tiene nombre | Cierra su `UsernameRecord` (rent → `player.owner`); `username.len = 0`; `username_changed_slot = slot`, así el enfriamiento vuelve a contar. **No toca** saldo, apuesta, sesión ni experiencia |
| `close_player()` | S: `owner` | `balance = 0`; `active_bet = None` | Cierra `UsernameRecord`, si existe, y `Player`. **Todos** sus lamports van a `owner`, incluidos los donados (§9). Se pierde la experiencia |

### 5.2 Apuestas (sustituyen a las de v1.1)

| Instrucción | Quién | Precondiciones | Efectos |
| --- | --- | --- | --- |
| `place_bet(round_id, stake, auto)` | O/S | Las de v1.1 (`!paused`, fase `Betting`, `slot < betting_end_slot`, `validateBet`, `bet_count < max_bets`, exposición de ronda, cobertura del vault) **más**: `authorize` (§4); `active_bet = None` (`ActiveBetPending`); `stake ≤ balance` (`InsufficientBalance`) | `balance −= stake`; mueve lamports `Player` → vault; `active_bet = Some({round_id, stake, auto, exposure, None})`; `reserved_exposure += exposure`; `total_exposure += exposure`; `bet_count += 1` |
| `cash_out()` | O/S | Las de v1.1 sobre `active_bet`: fase `Running`, `active_bet.round_id = round.round_id` (`BetRoundMismatch`), `cash_out_tick = None`, `tick < 196`, `recognized(tick) ≥ 1.01x` | `active_bet.cash_out_tick = Some(tick)` |
| `settle_bet()` | P | Fase `Crashed`, `Forfeited` o `Voided`; `active_bet = Some(b)` con `b.round_id = round.round_id` | Resultado idéntico a v1.1 §4. `payout ≤ b.exposure`; mueve `payout` vault → `Player`; `balance += payout`; `reserved_exposure −= b.exposure`; `settled_count += 1` (→ `Settled` si corresponde); **si la fase es `Crashed`**: `total_wagered += b.stake` y `bets_settled += 1`; `active_bet = None` |

- **Una apuesta por jugador y ronda:** `active_bet = None` impide una segunda apuesta mientras la primera no esté liquidada, y solo se puede liquidar en una fase terminal, cuando ya no se aceptan apuestas en esa ronda.
- **Apuesta sin liquidar de una ronda anterior:** el cliente pone `settle_bet` y `place_bet` en la misma transacción. El crank del operador sigue liquidando todas las apuestas.
- **Movimiento de lamports entre `Player` y vault:** ambas cuentas son del programa, así que se hace con `sub_lamports`/`add_lamports`, sin CPI.

### 5.3 Casa y rondas

- `initialize_house` y `update_config` aceptan también `player_policy` (validación en §6).
- `close_bet` **se elimina**.
- El resto de instrucciones es idéntico a v1.1: `deposit_bank`, `withdraw_bank`, `create_randomness_account`, `open_round`, `close_betting`, `start_round`, `reveal`, `void_round` y `forfeit_round`.

### 5.4 Pausa

- **Bloquea** las entradas: `open_round`, `place_bet`, `register_player`, `buy_coins` y `create_session`.
- **Nunca bloquea** las salidas ni la moderación: `sell_coins`, `revoke_session`, `cash_out`, `settle_bet`, `close_player`, `change_username`, `reset_username`, `reveal`, `void_round` y `forfeit_round`.

### 5.5 Transacciones típicas del cliente

| Flujo | Instrucciones en una transacción | Firmas de la wallet |
| --- | --- | --- |
| Alta | `register_player` + `buy_coins` + `create_session` | 1 |
| Apostar | [`settle_bet` de la apuesta anterior] + `place_bet` | 0 (firma la sesión, que también paga las comisiones) |
| Cash-out manual | `cash_out` | 0 |
| Renovar la sesión | Transferencia de la clave anterior al dueño (firma la clave anterior) + `create_session` | 1 |
| Salir | [`settle_bet`] + `revoke_session` + `sell_coins` + transferencia de la clave al dueño | 1 |

## 6. Valores por defecto

Propuestos en ADR 0003 y aceptados por el usuario. Los dos primeros viven en `HouseConfig`; el resto son valores de la UI.

| Parámetro | Valor inicial (devnet) | Validación en el programa |
| --- | --- | --- |
| `max_session_slots` | 1 512 000 (≈ 7 días a 400 ms/slot) | `> 0` |
| `username_cooldown_slots` | 1 512 000 (≈ 7 días) | Ninguna; 0 = sin enfriamiento |
| `betting_slots` / `entropy_timeout_slots` / `reveal_grace_slots` | **≈ 65 / 300 / 150** (desde el 2026-09-29, iteración 9: `betting_slots` = 15 s con la duración de slot medida de devnet, ≈ 230 ms; el valor exacto y su firma, en `changelog.md`. Antes 13, 50 y 25 slots de apuestas) | `> 0`. Se cambian con `update_config` (`pnpm operator:config`). `betting_slots` se puede cambiar con una ronda activa: cada ronda guarda su `betting_end_slot`. Los timeouts conviene cambiarlos sin ronda activa, porque `close_betting` usa el valor vigente para fijar el plazo de la entropía |
| Duración de la sesión (UI) | 216 000 slots (≈ 24 h) | `≤ max_session_slots` |
| `spend_cap` (UI) | El saldo en el momento de crear la sesión; el usuario puede cambiarlo | `> 0` |
| `fee_budget` (UI) | 0.01 SOL (≈ 2 000 transacciones con la comisión base) | Ninguna. Debe superar el mínimo exento de rent de una cuenta de 0 bytes (≈ 0.00089 SOL); si no, el runtime rechaza la transferencia |

- La duración se expresa en slots, no en horas: si los slots se ralentizan, la sesión dura más en tiempo real. La UI muestra la caducidad estimada.

## 7. Invariantes (cada uno con pruebas)

Se mantienen los invariantes de v1.1 §7, con estos cambios:

- **Se sustituyen:**
  - el 2 (contabilidad): `reserved_exposure = Σ exposure` de las `active_bet` de las rondas no liquidadas;
  - el 3: cada `ActiveBet` se liquida como mucho una vez, y su pago coincide con el del motor para la misma entrada;
  - el 7: los pagos sin permisos (`settle_bet`) solo van a la PDA `Player` dueña de la apuesta.
- **Se añaden:**

11. **Fondos del jugador:** `Player.lamports ≥ rent_min(Player) + balance` después de cada instrucción.
12. **Separación:** ninguna instrucción mueve lamports de `Player` salvo `place_bet` (solo hacia el vault, hasta `balance`) y `sell_coins`/`close_player` (solo hacia `owner`). `withdraw_bank` y las instrucciones del operador no tocan `Player`.
13. **Conservación en una apuesta:** entre `place_bet` y `settle_bet`, `balance_final = balance_inicial − stake + payout`, con el mismo `payout` que el motor.
14. **Sesión acotada:** una clave de sesión solo es un firmante válido en `place_bet` (sin caducar y dentro de `spend_cap`), `cash_out` y `revoke_session`. `spent` nunca supera `spend_cap`.
15. **Experiencia:** `total_wagered` y `bets_settled` solo aumentan en `settle_bet` de una ronda `Crashed`, una vez por apuesta. Nunca disminuyen salvo al cerrar `Player`.
16. **Unicidad del nombre:** para todo `Player` con nombre existe exactamente un `UsernameRecord` con esas seeds y `owner = player.owner`, y viceversa.
17. **Salida siempre disponible:** con la casa en pausa se pueden ejecutar `sell_coins`, `revoke_session`, `cash_out`, `settle_bet` y `close_player`.

## 8. Validación de cuentas y firmantes

| Instrucción | Signer | Validaciones de cuenta |
| --- | --- | --- |
| `register_player` | owner | `Player` con `init`, seeds `["player", owner]`; `UsernameRecord` con `init`, seeds `["username", nombre]`; System Program |
| `buy_coins`, `sell_coins`, `create_session`, `close_player` | owner | `Player` con seeds y bump y `has_one = owner`. `create_session`: `key` es una `SystemAccount` mutable. `close_player`: `UsernameRecord` con seeds del nombre actual y `owner = player.owner` (opcional solo si `username.len = 0`) y `close = owner` |
| `revoke_session` | owner o sesión | `Player` con seeds `["player", player.owner]` y bump; `authorize` |
| `change_username` | owner | `Player` con `has_one = owner`; nuevo `UsernameRecord` con `init`; anterior con seeds del nombre actual, `owner = player.owner` y `close = owner` (opcional solo si `username.len = 0`) |
| `reset_username` | admin | `HouseConfig` con `has_one = admin`; `Player` con seeds; `UsernameRecord` con seeds del nombre actual y `close` hacia una cuenta con `address = player.owner` |
| `place_bet` | owner o sesión | Las de v1.1 salvo `Bet`; `Player` con seeds `["player", player.owner]` y bump; `authorize` |
| `cash_out` | owner o sesión | `Round` con seeds; `Player` con seeds; `authorize`; `active_bet.round_id = round.round_id` |
| `settle_bet` | — (P) | `Round` y vault con seeds; `Player` con seeds `["player", player.owner]`; `active_bet.round_id = round.round_id`. Ya no hace falta la cuenta del jugador como destino: el pago va a la PDA |

Reglas generales, además de las de v1.1 §8:
- Las únicas CPIs nuevas son transferencias del System Program firmadas por el owner (`buy_coins`, `create_session`).
- `Player` se valida siempre por sus seeds con el `owner` guardado. Así, una `Player` de otro jugador o falsificada no pasa.

## 9. Amenazas nuevas

| Amenaza | Mitigación |
| --- | --- |
| Robo de la clave de sesión (XSS, extensión) | Solo puede apostar hasta `spend_cap` antes de `expires_slot`, hacer cash-out y revocarse; nunca vende ni cierra. Pérdida máxima: `spend_cap` apostado con mala estrategia + `fee_budget`. El dueño puede revocarla |
| Sesión usada para hacer cash-out antes de tiempo tras caducar | Solo recorta la ganancia de una apuesta que ya existe; no mueve fondos. Se acepta para no dejar al jugador sin salida |
| El operador o el admin toman saldos | Ninguna instrucción suya mueve lamports de `Player` (invariante 12) |
| Pago a otra cuenta en `settle_bet` | El destino es la PDA validada por seeds; `sell_coins` y `close_player` pagan solo a `owner` |
| Donaciones de lamports a una PDA `Player` | No son `balance`; mantienen el invariante 11 (`≥`). Van a `owner` al cerrar |
| Apuesta de una ronda liquidada contra otra ronda | `active_bet.round_id = round.round_id` en `cash_out` y `settle_bet` |
| Doble liquidación | `active_bet` se vacía de forma atómica; una segunda llamada falla con `NoActiveBet` |
| Apuesta nueva con otra pendiente | `ActiveBetPending` en `place_bet` |
| Experiencia inflada | Solo `settle_bet` en rondas `Crashed`; void y forfeit no suman |
| Nombre suplantado con homoglifos o mayúsculas | Charset `[a-z0-9_]`; la UI muestra también la dirección abreviada |
| Un tercero se adelanta y registra el nombre | Quien llega primero se lo queda; se acepta |
| Nombre ofensivo | `reset_username` (admin). Un nombre liberado puede volver a registrarse: prohibir nombres queda fuera de v2 |
| Admin abusa de `reset_username` | Solo afecta al nombre; queda registrado en un evento |
| Cerrar `Player` con fondos o apuesta | `PlayerNotEmpty` |
| Denegación de servicio con muchas `Player` | Cada una cuesta su rent a quien la crea; el programa no las recorre |

## 10. Eventos

- **Nuevos:**
  - `PlayerRegistered { owner, username }`
  - `CoinsBought { owner, amount, balance }`
  - `CoinsSold { owner, amount, balance }`
  - `SessionCreated { owner, key, expires_slot, spend_cap }`
  - `SessionRevoked { owner, key }`
  - `UsernameChanged { owner, old, new }`
  - `UsernameReset { owner, old }`
  - `PlayerClosed { owner }`
- **Ampliados:**
  - `BetPlaced`: añade `by_session: bool`;
  - `BetSettled`: añade `stake`, `auto_cash_out`, `cash_out_tick`, `balance` y `total_wagered`. Así cada apuesta queda auditable desde sus eventos, sin cuentas `Bet`.
- Las proyecciones (historial, experiencia, nombres, chat) se reconstruyen desde estos eventos y desde las cuentas `Player` y `Round`.

## 11. Errores nuevos

- `InvalidUsername`
- `UsernameCooldown`
- `Unauthorized`: el firmante no es el dueño ni una sesión válida para esa acción
- `SessionExpired`
- `SessionSpendCapExceeded`
- `InvalidSession`: clave no válida o caducidad fuera de rango
- `NoSession`
- `InsufficientBalance`
- `ActiveBetPending`
- `NoActiveBet`
- `BetRoundMismatch`
- `PlayerNotEmpty`
- `UsernameRecordMismatch`: el `UsernameRecord` pasado no corresponde al nombre actual del jugador, o falta cuando lo tiene
- Se elimina `BetAlreadySettled`: liquidar dos veces devuelve `NoActiveBet`

## 12. Pruebas previstas

- **LiteSVM, flujo:** alta en una sola transacción (registro + compra + sesión) → apuesta firmada por la sesión → cash-out → liquidación → venta. Comprobar el saldo exacto de la wallet y de la PDA en cada paso.
- **Apuesta pendiente:** `settle_bet` + `place_bet` en la misma transacción.
- **Void y forfeit:** reembolso al saldo, sin experiencia.
- **Límites de sesión:** tope de gasto exacto (±1 lamport), caducidad exacta (±1 slot), cash-out con la sesión caducada, sesión reemplazada (la clave anterior deja de valer) y revocación por el dueño y por la sesión.
- **Nombres:** charset, longitud (2, 3, 16 y 17 bytes), mayúsculas rechazadas, duplicado, enfriamiento exacto, cambio que libera el nombre anterior, reset del admin y otro jugador que retoma el nombre liberado.
- **Adversariales:**
  - la sesión intenta `sell_coins`, `close_player`, `create_session` o `change_username`;
  - otro jugador firma por una `Player` ajena;
  - `Player` falsificada;
  - `settle_bet` con otra ronda;
  - doble liquidación;
  - venta por encima del saldo;
  - cierre con saldo o con apuesta;
  - `reset_username` por alguien que no es el admin;
  - donación de lamports seguida de venta y cierre.
- **Pausa:** las salidas de §5.4 siguen funcionando.
- **Invariantes 1, 11 y 16 comprobados tras cada transacción**, y el 2 al final de cada ronda.
- **Sin cambios:** las pruebas de randomness, Switchboard, `reveal`, `void`, `forfeit` y el adaptador; se adaptan solo para usar saldos.
- **Devnet end-to-end:** varias rondas con apuestas firmadas por sesión contra el Switchboard real, y verificación independiente de cada liquidación a partir de los eventos.

## 13. Despliegue y migración (devnet)

`HouseConfig` cambia de layout y `Bet` desaparece, así que v2 **no puede ser un upgrade in situ** de la casa actual. Propuesta:

1. Terminar o anular la ronda en curso de v1.1, liquidar y cerrar sus `Bet`, y retirar el bank disponible con `withdraw_bank`.
2. Desplegar v2 con un **program id nuevo** (keypair nuevo en `$CARGO_TARGET_DIR/deploy`, `anchor keys sync`). El programa v1.1 (`384Cf…`) se queda como está: sus rondas siguen siendo verificables con su `program_id`.
3. `initialize_house` y `create_randomness_account` en el programa nuevo. La authority PDA de randomness cambia con el program id.
4. Actualizar `CLAUDE.md`, `Anchor.toml` y la documentación con el nuevo program id.

Alternativa descartada: reutilizar el program id con seeds nuevas (`"house_v2"`). Mezclaría dos layouts en el mismo programa y complicaría el verificador sin ninguna ventaja en devnet.

## 14. Decisiones pendientes de aprobación

| # | Decisión | Propuesta |
| --- | --- | --- |
| 1 | Cash-out y revocación con la sesión caducada | Permitidos (§4); la caducidad solo limita `place_bet` |
| 2 | Qué bloquea la pausa | §5.4 |
| 3 | Valores iniciales | §6 |
| 4 | Despliegue de v2 | Program id nuevo (§13) |
| 5 | Nombres liberados | Se pueden volver a registrar; prohibir nombres queda fuera de v2 |

## 15. Estado de la implementación (2026-09-29)

- **Código:** `programs/solana/programs/crash`:
  - `src/instructions/player.rs`: instrucciones de jugador;
  - `src/instructions/bet.rs`: apuestas sobre `Player.active_bet`;
  - `src/state.rs`: `Player`, `UsernameRecord`, `ActiveBet`, `Session`, `Username` y `PlayerPolicy`.
- **Program id nuevo:** `DNmfJzhj6Uaa1Zbd2HhUT9mES27jhzXkMThDm3ikRarM`. `declare_id!` y `Anchor.toml` apuntan ya a él, así que un despliegue accidental no puede sobrescribir v1.1. Los keypairs de los programas están fuera del repo, en `$CARGO_TARGET_DIR/deploy/`: el de v2 en `crash-keypair.json` y el de v1.1 (`384Cf…`) guardado en `crash-v1-keypair.json`.
- **Pruebas:** 19 en LiteSVM, todas en verde, que cubren §12:
  - alta en una sola transacción y ciclo completo con sesión hasta vender y cerrar, con los importes exactos de la wallet;
  - compra y venta 1:1 y donaciones;
  - límites exactos de la sesión (tope de gasto y caducidad), cash-out y revocación con la sesión caducada, sustitución de la sesión;
  - la sesión rechazada en las instrucciones reservadas al dueño;
  - nombres: charset, longitudes, duplicado, enfriamiento exacto, reset del admin y nombre liberado;
  - `settle_bet` + `place_bet` en la misma transacción;
  - void y forfeit sin experiencia;
  - `Player` falsificada;
  - pausa con las salidas abiertas.

  Los invariantes 1, 11 y 16 se comprueban después de cada transacción.
- **Resto de pruebas Rust:** 6 del adaptador de Switchboard, 8 de propiedades y 5 de vectores, sin cambios y en verde. `cargo clippy --all-targets` sin avisos.
- **Compute units con el mock:**
  - alta (registro + compra + sesión): 37 611;
  - `place_bet`: 14 847;
  - `close_betting`: 15 126;
  - `start_round`: 58 099.
- **Despliegue en devnet** (2026-09-29), siguiendo §13:
  1. Casa v1.1 cerrada en la práctica: no tenía ronda activa ni apuestas, y se retiró su bank disponible (0.2507 SOL). El programa `384Cf…` sigue desplegado para que sus rondas se puedan seguir consultando.
  2. Programa v2 en `DNmfJzhj6Uaa1Zbd2HhUT9mES27jhzXkMThDm3ikRarM`. La autoridad de upgrade es `3R48…` y el binario on-chain coincide con el local (SHA-256 `ec159e4c…b863`). Rent del programa: 2.609 SOL.
  3. Casa: `HouseConfig` `Sbko1ZRWWaWvWgedE7TVkKWWkKTTLWCtzQGHzRfEt9d` y vault `PRoeDVdvyg9Ugm8np7LUWLg94uXArvwdBBt1jpSRqQE`, con un bank de 0.3 SOL.
     - Límites de devnet: stake de 1 a 2 monedas, pago máximo de 200 monedas y exposición por ronda de 500 monedas.
     - Timeouts 25/150/150 y `player_policy` de §6.
     - Cuenta de randomness `3gNTQo8XRg1HomKXtpkq6GWr5jHvcxkG4xV15bzMkjTR`, cuya authority es la PDA `46cA9XaCNcmrUyz5Eez7cN3KBPNVAkcDi6axGGJLH87E`.
- **Prueba end-to-end** contra el Switchboard real, con un cliente desechable fuera del repo y dos jugadores desechables:
  - **Alta:** una sola firma de wallet por jugador (registro + compra de 20 monedas + sesión).
  - **Rondas:** 11 abiertas.
    - 9 completas y reveladas: crash points de 1.02x a 9.45x, todos idénticos a un verificador independiente en JS escrito desde la spec de reglas.
    - 1 anulada por el operador (ronda 1), porque el cliente se interrumpió.
    - 1 abierta para la prueba adversarial y anulada.
  - **Firmas:** todas las apuestas y los cash-outs los firmaron (y pagaron) las claves de sesión. Las apuestas pendientes se liquidaron en la misma transacción que la apuesta siguiente.
  - **Liquidaciones:** 19 verificadas, **0 discrepancias** (cash-outs manuales, autos a 2.00x ganadores y perdedores, reembolso de la ronda anulada).
  - **Experiencia:** solo contó las rondas `Crashed` (9 apuestas por jugador; la anulada no suma).
  - **Adversariales on-chain** (simulados):
    - una sesión intentando vender, rechazada con `ConstraintSeeds`;
    - el operador apostando con el saldo de un jugador, rechazado con `Unauthorized`.
  - **Salida:** revocar la sesión, vender todo, barrer la clave de sesión y cerrar. Las cuentas `Player` y `UsernameRecord` quedaron cerradas y las wallets desechables vacías.
  - **Compute units reales:**
    - `place_bet`: 14 847;
    - `settle_bet` + `place_bet`: 26 505–50 320;
    - `cash_out`: ≈ 11 100;
    - `close_betting`: ≈ 28 000;
    - `start_round`: 97 142–101 642;
    - `reveal`: 9 536–27 020;
    - `settle_bet`: 12 053–33 873;
    - salida completa: 15 871.
- **Hallazgo de cliente:** la ventana de apuestas de 25 slots (≈ 10 s) es justa cuando la RPC pública limita la tasa (HTTP 429). En la primera ejecución, una apuesta llegó tarde y el programa la rechazó correctamente con `BettingClosed`, sin efectos. El cliente definitivo debe preparar y firmar las transacciones antes de que abra la ronda y usar una RPC con cuota suficiente. **Resuelto el 2026-09-29:** `betting_slots` pasa a 50 (≈ 20 s) y `entropy_timeout_slots` a 300, aplicados en la casa de devnet con `update_config` (el resto de la configuración, sin cambios).
