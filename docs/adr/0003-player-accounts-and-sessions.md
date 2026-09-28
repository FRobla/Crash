# ADR 0003 — Cuentas de jugador, monedas y sesiones

- Estado: **propuesto** (2026-09-28). Incorpora las decisiones del usuario del 2026-09-28: opción A, nombre de usuario on-chain, el nivel dará ventajas en el futuro, sin comisión de compra/venta y chat con base de datos. Quedan por confirmar los puntos de [Preguntas abiertas](#preguntas-abiertas).
- Fecha: 2026-09-28
- Relacionado: [ADR 0001](0001-settlement-authority.md) (se mantiene), [ADR 0002](0002-randomness-source.md) (sin cambios), [spec del programa](../specs/crash-program.md) (exigirá una v2), [spec de reglas](../specs/crash-round-rules.md) (sin cambios)

## Contexto

Flujo de producto pedido:
1. El jugador conecta su wallet y elige un **nombre de usuario**, que crea su usuario para esa wallet.
2. **Compra monedas** con SOL (1 SOL = 1000 monedas) y juega con ellas, sin firmar una transacción en la wallet por cada apuesta.
3. Jugar da **experiencia** y sube de **nivel**. Los niveles darán ventajas en el futuro.
4. Cuando quiere, **vende** sus monedas y recupera el SOL.

Hoy, cada `place_bet` saca el stake de la wallet del jugador y cada `settle_bet` le devuelve el pago a la wallet (`instructions/bet.rs`). Cada apuesta y cada cash-out manual es una transacción que el jugador firma. Además, cada apuesta crea una cuenta `Bet` que el jugador paga y recupera al cerrarla.

Restricciones que no cambian:
- El programa sigue siendo la autoridad de apuestas, cash-outs y pagos, y el orden se fija por slot (ADR 0001).
- Cada ronda y cada liquidación deben poder verificarse on-chain.
- Ningún servicio off-chain decide sobre el dinero.

## Opciones

### A. Saldo on-chain en una PDA del jugador + clave de sesión (elegida)

El saldo vive en una cuenta del programa por jugador. Las apuestas y los cash-outs siguen siendo transacciones, pero las firma una **clave de sesión** del navegador, con permisos limitados, sin ventanas de la wallet.

- Se mantienen ADR 0001 y ADR 0002, y todo sigue siendo verificable on-chain.
- La wallet solo firma al registrarse y comprar, al abrir una sesión y al vender.
- Coste por apuesta: la comisión base (5 000 lamports = 0.005 monedas) más la priority fee opcional.

### B. Saldo off-chain en una base de datos del operador (descartada)

Solo la compra y la venta van on-chain; el servidor registra apuestas y cash-outs.

- Descartada: el servidor decidiría el orden de los cash-outs y sería la autoridad sobre el dinero. Es la opción B que ADR 0001 rechazó.
- Solo el crash point sería verificable, no las apuestas ni los pagos. Además, el operador custodiaría los fondos.

## Decisión (propuesta)

### 1. Monedas

- **Una moneda = 10⁶ lamports** (1 SOL = 1000 monedas). La moneda tiene 6 decimales y su unidad base es **exactamente 1 lamport**.
- Las monedas no son un token SPL ni se pueden transferir entre jugadores. Solo son la forma en que se muestra el saldo en SOL del jugador dentro del programa.
- Consecuencias:
  - comprar y vender es 1:1, sin conversión, sin redondeo y sin riesgo de tipo de cambio para la casa;
  - el motor, las reglas v1 y los vectores no cambian: siguen trabajando en lamports;
  - la UI formatea lamports como monedas. El formateo es presentación, nunca aritmética económica.
- **Sin comisión** de compra ni de venta: la única ventaja de la casa es el edge declarado en las reglas.
- Las monedas valen lo que vale el SOL. Su precio en dólares cambia con el del SOL, y la UI debe decirlo.

### 2. Cuentas nuevas

| Cuenta | Seeds | Campos principales |
| --- | --- | --- |
| `Player` | `["player", owner]` | `owner`, `username`, `balance: u64` (lamports libres), `active_bet: Option<ActiveBet>`, `session: Option<Session>`, `total_wagered: u64`, `bets_settled: u64`, `created_slot`, `bump` |
| `Username` | `["username", nombre_normalizado]` | `owner`, `bump`. Garantiza que el nombre sea único |

- `ActiveBet { round_id, stake, auto_cash_out, exposure, cash_out_tick: Option<u64> }` sustituye a la cuenta `Bet`. Un jugador tiene como mucho una apuesta en curso, lo que ya coincide con la regla v1 de una apuesta por jugador y ronda. Así se elimina el rent que se crea y devuelve en cada apuesta.
- `Session { key: Pubkey, expires_slot, spend_cap, spent }`: una sesión por jugador. Crear otra reemplaza la anterior.
- Los lamports del saldo viven **en la propia PDA `Player`**, separados del vault de la casa. `withdraw_bank` no puede tocarlos por construcción.
- Rent de registro ≈ 0.0035 SOL (`Player` + `Username`), recuperable con `close_player`.

### 3. Instrucciones nuevas o modificadas

| Instrucción | Firma | Efecto |
| --- | --- | --- |
| `register_player(username)` | owner | Crea `Player` y `Username`. Se puede combinar con `buy_coins` en la misma transacción |
| `buy_coins(amount)` | owner | Wallet → PDA `Player` (CPI al System Program); `balance += amount` |
| `sell_coins(amount)` | owner | PDA `Player` → wallet del owner, que es el **único destino posible**; `balance -= amount`. **La pausa no la bloquea** |
| `create_session(key, expires_slot, spend_cap, fee_budget)` | owner | Guarda la sesión y transfiere `fee_budget` lamports de la wallet a `key` para pagar las comisiones |
| `revoke_session()` | owner **o** la propia sesión | Borra la sesión. La pausa no la bloquea |
| `place_bet(stake, auto)` | owner **o** sesión válida | Las validaciones actuales, más `active_bet = None`, `stake ≤ balance` y, con sesión, `slot ≤ expires_slot` y `spent + stake ≤ spend_cap`. Mueve el stake de la PDA `Player` al vault y rellena `active_bet` |
| `cash_out()` | owner **o** sesión válida | Igual que hoy, sobre `active_bet` |
| `settle_bet()` | P | Igual que hoy, pero el pago va del vault a la PDA `Player` (`balance += payout`) y vacía `active_bet`. Actualiza la experiencia (§5) |
| `change_username(new)` | owner | Cierra el `Username` anterior y crea el nuevo |
| `reset_username()` | admin | Libera un nombre ofensivo y deja un nombre por defecto derivado del owner. **Solo toca el nombre**: nunca saldo, apuesta ni experiencia |
| `close_player()` | owner | Exige `balance = 0` y `active_bet = None`. Cierra `Player` y `Username`, y el rent vuelve al owner. Se pierde la experiencia |

- `close_bet` y la cuenta `Bet` desaparecen.
- Si el jugador tiene una apuesta sin liquidar de una ronda terminada, el cliente pone `settle_bet` y `place_bet` en la misma transacción.
- Pagos entre cuentas del programa (`Player` ↔ vault): se mueven lamports directamente, sin CPI.

### 4. Clave de sesión

- Es un keypair generado en el navegador, que es también el **fee payer** de sus transacciones. Solo puede ejecutar `place_bet`, `cash_out` y `revoke_session`.
- **Nunca** puede vender, cambiar el nombre, crear otra sesión ni cerrar la cuenta.
- Si una XSS o una extensión la roba, lo peor que puede pasar es que se apueste el saldo hasta `spend_cap` antes de `expires_slot`. **No puede sacar fondos del programa.** La única pérdida posible es el `fee_budget` que se envió a la clave.
- Los valores por defecto (duración, tope y presupuesto de comisiones) se fijan en la spec y la UI los muestra al crear la sesión.
- Los usuarios con hardware wallet pueden seguir firmando cada apuesta con la wallet.

### 5. Experiencia y nivel

- Como los niveles darán **ventajas económicas**, la experiencia es un dato autoritativo y vive **on-chain**:
  - `settle_bet` suma el stake a `total_wagered` y cuenta `bets_settled` **solo** en las rondas `Crashed` con resultado `CashedOut` o `Lost`;
  - los reembolsos de rondas `Voided` o `Forfeited` no cuentan: así no se gana experiencia sin riesgo.
- **XP = `total_wagered` expresado en monedas.** El nivel lo calcula una función pura y versionada (`PROGRESSION_V1`) que vive en el código TypeScript y en Rust, con vectores compartidos, igual que las reglas de Crash.
- Las ventajas aún no se definen. Antes de habilitar cualquiera hacen falta:
  - una spec económica propia y versionada;
  - aplicarlas en el programa, no en la UI ni en un servicio;
  - **el invariante de rentabilidad:** para cualquier estrategia, el valor esperado de las ventajas por unidad apostada debe ser menor que el edge. Si no, apostar con auto cash-out a 1.01x fabricaría experiencia con retorno positivo.
- Varias wallets de un mismo jugador no suponen un problema: cada wallet paga el edge por su propia experiencia.

### 6. Nombre de usuario

- **On-chain**, en `Player`, con unicidad mediante la PDA `Username`.
- Formato: 3–16 caracteres `[a-z0-9_]`, que se normaliza a minúsculas antes de derivar la PDA. El charset restringido evita que se suplante a otro con homoglifos. El programa rechaza cualquier otro formato.
- Es **público y permanente** en la historia de la cadena, y la UI debe avisarlo al registrarse. Recomendación visible: no usar datos personales.
- Quien llega primero se queda el nombre. `reset_username` del admin es la única herramienta de moderación on-chain.

### 7. Chat y base de datos (fuera de este ADR)

El chat necesita un backend con base de datos, que hoy no existe. Su elección (hosting, base de datos, WebSockets) será un **ADR propio**. Restricciones que este ADR le impone:

- La base de datos **nunca es autoridad** sobre saldos, apuestas, experiencia ni nombres. Como mucho los guarda en caché desde la cadena y los puede reconstruir.
- **Identidad en el chat:** el usuario firma un mensaje, sin transacción, con la wallet o con la clave de sesión. Una clave de sesión se puede verificar contra `Player.session` on-chain, así el chat no abre ventanas de la wallet. El nombre mostrado sale de `Player`.
- Los mensajes son datos personales: hacen falta una política de retención, moderación (bans off-chain, independientes del nombre on-chain), límites de tasa y escapado del contenido contra XSS, que además protege la clave de sesión.

## Invariantes (se añadirán a la spec v2 con pruebas)

1. **Fondos del jugador:** `Player.lamports ≥ rent_min + balance` después de cada instrucción.
2. **Solvencia de la casa**, sin cambios: `vault.lamports − rent_min ≥ reserved_exposure`.
3. **Conservación:** el total de lamports de `Player`s y vault solo cambia con `buy_coins`, `sell_coins`, `deposit_bank`, `withdraw_bank` y rent. Una apuesta y su liquidación solo mueven lamports entre `Player` y vault.
4. **Destino único:** los lamports de `Player` solo salen hacia el vault (`place_bet`) o hacia `owner` (`sell_coins` y `close_player`).
5. **Sesión acotada:** una sesión nunca aparece como firmante válido fuera de `place_bet`, `cash_out` y `revoke_session`, ni pasado `expires_slot`, ni superado `spend_cap`.
6. **Salida siempre disponible:** la pausa nunca bloquea `sell_coins`, `revoke_session`, `cash_out`, `settle_bet` ni `close_player`.
7. **Experiencia:** `total_wagered` solo crece en `settle_bet` de rondas `Crashed` y nunca se cuenta dos veces.
8. **Unicidad:** un nombre normalizado pertenece como mucho a un `Player`.

## Amenazas

| Amenaza | Mitigación |
| --- | --- |
| Robo de la clave de sesión | Permisos limitados, `spend_cap`, `expires_slot` y revocación. Nunca puede vender |
| El operador o el admin toman saldos | No hay ninguna instrucción que mueva lamports de `Player` salvo el owner o una apuesta válida |
| Donaciones de lamports a una PDA `Player` | No afectan al invariante 1 (`≥`). El excedente no se contabiliza como saldo |
| Doble liquidación o apuesta colgada | `active_bet` se vacía de forma atómica al liquidar; `place_bet` exige `active_bet = None` |
| Experiencia falsa | Solo la escribe `settle_bet`, y solo en rondas `Crashed` |
| Farmeo de experiencia con ventajas futuras | Invariante de rentabilidad (§5) antes de habilitar cualquier ventaja |
| Suplantación visual del nombre | Charset `[a-z0-9_]`; la UI muestra además la dirección abreviada |
| Nombres ofensivos | `reset_username` (solo del admin y solo afecta al nombre) y moderación del chat off-chain |
| El chat o la base de datos muestran datos falsos | La cadena es la fuente; la UI toma los saldos del RPC, nunca de la base de datos |

## Consecuencias

- **Spec del programa v2** (spec-first): cuentas `Player` y `Username`, sesiones, apuesta embebida, instrucciones de §3, invariantes y validación de cuentas y firmantes. Después, la implementación y las pruebas LiteSVM, incluidas las adversariales de sesión.
- **Compatibilidad:** desaparece `Bet` y cambian `place_bet`, `cash_out` y `settle_bet`. En devnet se inicializa una casa nueva (o un program id nuevo); no hay fondos reales afectados.
- **Spec de progresión** con `PROGRESSION_V1` y sus vectores.
- **Web:**
  - en `platform/`, una capacidad de jugador (perfil, experiencia, nivel) y una de caja (compra y venta);
  - la UI de sesión en el adaptador de Solana;
  - "Bank" sigue siendo el house bank.
- El historial de apuestas ya no queda en cuentas `Bet`, sino en los eventos `BetPlaced` y `BetSettled` y en las cuentas `Round`. El verificador y el historial necesitan un RPC con histórico o un indexador; hoy pasa lo mismo, porque las cuentas `Bet` ya se podían cerrar.
- **Regulación:** que el saldo sea on-chain y lo pueda retirar su dueño en cualquier momento reduce la custodia, pero no cambia la naturaleza de juego con valor real. Sigue haciendo falta revisión legal antes de mainnet.

## Preguntas abiertas

1. **Comisiones de la sesión:** propuesta, la wallet transfiere `fee_budget` a la clave de sesión al crearla. No hace falta backend, y lo que quede se recupera al revocar si la clave sigue disponible. Alternativa: un relayer del operador paga las comisiones, lo que exige un servicio y pasa a ser un punto de liveness.
2. **USDC:** propuesta, saldos separados por activo (`Player` por activo o por mint), sin mezclar SOL y USDC en una misma moneda, para no crear riesgo cambiario para la casa.
3. **Valores por defecto de la sesión:** duración, `spend_cap` y `fee_budget`.
4. **Cambio de nombre:** ¿libre, con un periodo mínimo entre cambios o con un límite de cambios?
5. **Cerrar la cuenta:** ¿se permite `close_player` sabiendo que se pierde la experiencia (y con ella las ventajas futuras)?
