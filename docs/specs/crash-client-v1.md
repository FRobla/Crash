# Spec — Versión funcional mínima: crank del operador, cliente web y verificación (v1)

- Estado: **aprobada v1** (2026-09-29): el usuario aprueba las decisiones de la §11. **Implementada** (§13).
- Fecha: 2026-09-29
- Programa: [spec v2](crash-program-v2.md) (vigente), sobre [v1.1](crash-program.md). Esta spec **no cambia el programa** ni las reglas: es un cliente del programa desplegado `DNmfJ…`.
- Reglas: [`crash-round-rules.md`](crash-round-rules.md) v1, sin cambios. Randomness: [ADR 0002](../adr/0002-randomness-source.md). Cuentas de jugador: [ADR 0003](../adr/0003-player-accounts-and-sessions.md).
- Decisiones del usuario (2026-09-29): crank en Node dentro del repo, clave de sesión en `localStorage`, codec propio sin el cliente TS de Anchor, alcance Crash + Fairness + History.
- Red: **solo devnet**.

## 1. Alcance

**Dentro:**
1. **Codec TS del programa**: instrucciones, cuentas y eventos, escrito a mano sobre `@solana/web3.js` y probado contra el IDL.
2. **Crank del operador**: proceso Node que ejecuta el ciclo de rondas sin intervención y se recupera tras un reinicio.
3. **Web, Crash**: ronda en vivo, alta, compra, sesión, apuesta, cash-out manual y automático, venta y salida.
4. **Web, History**: últimas rondas y últimas apuestas del jugador conectado.
5. **Web, Fairness**: verificación independiente de cualquier ronda con el motor TS.

**Fuera:** Bank (vista del admin), cambio y reset de nombre en la UI, `close_player` en la UI, progresión y niveles, chat, USDC, backend o indexador propio, vigilantes que ejecuten `close_betting`/`start_round` desde el navegador, y mainnet.

## 2. Módulos

| Módulo | Ruta | Depende de |
| --- | --- | --- |
| Verificación provably fair (esquema C, agnóstico de cadena) | `src/games/crash/fairness/` | `games/crash/domain` |
| Puerto de la partida en vivo (vistas y acciones que consume la UI) | `src/games/crash/ui/` (tipos del puerto junto a la UI) | `games/crash/domain` |
| Puerto de cuentas de jugador (saldo, sesión, alta) | `src/platform/player-accounts/` | — |
| Codec del programa y decodificación de eventos | `src/chain-adapters/solana/crash-program/` | `@solana/web3.js` |
| Adaptador Solana de los puertos (suscripciones, transacciones, clave de sesión) | `src/chain-adapters/solana/crash-program/` | codec, puertos de `games` y `platform` |
| Adaptador off-chain de Switchboard (selección de oráculo, gateway) | `src/chain-adapters/solana/switchboard/` | `@solana/web3.js` |
| Crank del operador | `services/operator/` | codec, adaptador de Switchboard, `games/crash/domain`, `games/crash/fairness` |

- La composición sigue ocurriendo en `src/app`: las páginas inyectan el adaptador Solana en los puertos. `games/*` y `platform/*` siguen sin importar de `chain-adapters/*`.
- `services/operator/` es código de servidor: **nunca** se importa desde `src/app` ni entra en el bundle del navegador.

## 3. Codec del programa

- **Fuente de verdad:** el IDL generado por `anchor build` se versiona en `src/chain-adapters/solana/crash-program/idl/crash.json`. Se regenera solo cuando cambie el programa.
- **Instrucciones:** discriminador de 8 bytes, argumentos en Borsh little-endian y `AccountMeta` en el orden del IDL. Solo se implementan las que usa esta spec:
  - jugador: `register_player`, `buy_coins`, `sell_coins`, `create_session`, `revoke_session`, `place_bet`, `cash_out`, `settle_bet`;
  - crank: `open_round`, `close_betting`, `start_round`, `reveal`, `void_round`, `forfeit_round`.
- **Cuentas:** decodificadores de `HouseConfig`, `HouseVault`, `Round` y `Player` que comprueban el discriminador, el owner (= program id) y la longitud mínima. Cualquier desajuste es un error, nunca un valor por defecto.
- **PDAs:** `house`, `vault`, `round(id_le)`, `player(owner)`, `username(bytes)` y `randomness_authority`.
- **Eventos:** se decodifican de las líneas `Program data:` de los logs con el discriminador del IDL. Solo se usan para History; el estado de las cuentas es la fuente para todo lo demás.
- **Importes:** siempre `bigint` en lamports. Los multiplicadores, en `bigint` de diezmilésimas, igual que el motor.

## 4. Crank del operador

### 4.1 Arranque

1. Lee `CRASH_OPERATOR_KEYPAIR` (ruta del keypair) y `CRASH_OPERATOR_STATE_DIR` (directorio de semillas). **Se niega a arrancar** si alguna ruta está dentro del repo.
2. Comprueba que el genesis hash del RPC sea el de devnet y que `HouseConfig.operator` coincida con su clave pública.
3. **Recupera** el estado desde la cadena (§4.3) antes de abrir nada.

La clave privada y las semillas no reveladas nunca se escriben en logs, errores ni salida.

### 4.2 Ciclo por ronda

| Paso | Instrucción | Cuándo | Si falla |
| --- | --- | --- | --- |
| 1 | Genera `seed` (32 bytes de CSPRNG), la guarda en disco (§4.4) y calcula `commit` | `current_round = None` y ha pasado la pausa entre rondas (§11, 5) | Reintenta; sin ronda no hay riesgo |
| 2 | `open_round(commit)` | Tras guardar la semilla con `fsync` | Reintenta mientras `next_round_id` no cambie |
| 3 | `close_betting` con el oráculo elegido (§4.5) | `slot ≥ betting_end_slot` | Reintenta con otro oráculo. Si no lo consigue antes de `betting_end_slot + entropy_timeout_slots`, `void_round` (puede hacerlo el operador en `Betting`) |
| 4 | `start_round` con el payload del gateway (§4.5) | Nada más confirmar el commit | Reintenta hasta `entropy_deadline_slot`. Después, `void_round` sin permisos |
| 5 | `reveal(seed)` | Cuando `slot ≥ start_slot + crash_tick`, calculado con el motor TS | Reintenta hasta `reveal_deadline_slot`. Si no lo logra, `forfeit_round` (lo pierde la casa, §10) |
| 6 | `settle_bet` de cada `Player` con apuesta en la ronda | Fase terminal (`Crashed`, `Voided` o `Forfeited`) | Reintenta. Un jugador también puede liquidar en su siguiente apuesta; es idempotente (`NoActiveBet`) |
| 7 | Borra la semilla de disco | `reveal` confirmado (la semilla ya es pública) | — |

- **Apuestas de la ronda:** `getProgramAccounts` con filtros `memcmp` sobre el discriminador de `Player`, `active_bet = Some` (offset 73 = `1`) y `active_bet.round_id` (offset 74). El crank no confía en los eventos para saber a quién pagar.
- **Confirmaciones:** se espera a `confirmed` antes de avanzar de paso, **consultando el estado de la firma** (sin WebSocket: la RPC pública limita las suscripciones y `confirmTransaction` de web3.js dejaba rechazos sin capturar). Cada transacción lleva priority fee (§11, 6); si caduca, el siguiente paso la reconstruye con un blockhash nuevo. Un rechazo no capturado de una librería se registra y el bucle sigue: cada decisión se vuelve a derivar de la cadena.

### 4.3 Recuperación tras reinicio

| Estado on-chain (`current_round`) | Acción |
| --- | --- |
| `None` | Liquida las apuestas pendientes de las últimas rondas terminales y vuelve al paso 1 |
| `Betting` y existe la semilla con el mismo `commit` | Continúa en el paso 3 |
| `Betting` sin semilla válida | `void_round` inmediato: nadie conoce el resultado y los stakes vuelven íntegros |
| `AwaitingEntropy` | Paso 4 si hay semilla. Sin semilla, no inicia la ronda y espera al plazo para anularla (cualquiera podría iniciarla, en cuyo caso acabaría en `forfeit`) |
| `Running` | Paso 5 si hay semilla. Sin ella, `forfeit` tras el plazo |

### 4.4 Custodia de la semilla

- Un archivo por ronda: `<STATE_DIR>/<program_id>/round-<id>.seed`. Se escribe **antes** de enviar `open_round`, con `fsync` del archivo y del directorio y permisos solo para el usuario cuando el sistema lo permite.
- **Nunca se sobrescribe:** si `open_round` no llega a confirmarse, el reintento reutiliza la misma semilla para ese `round_id`. Así, un `open_round` que aterriza tarde siempre encuentra la semilla a la que se comprometió.
- Perder la semilla de una ronda en `Running` provoca un `forfeit`. Es el caso que la regla penaliza a propósito; el disco local es un supuesto de liveness declarado (§10).

### 4.5 Switchboard off-chain (sin SDK)

Se escribe a mano, como el adaptador on-chain, a partir del SDK `@switchboard-xyz/on-demand` 3.10.6 y `@switchboard-xyz/common` 5.8.5 (leídos, no instalados):
- **Elección del oráculo:** lee la cola de la cuenta de randomness y, de sus oráculos, se queda con los que estén en la cola, verificados, con heartbeat reciente y cotización del enclave vigente. Elige uno al azar entre ellos y, si el commit falla, prueba con otro. Los layouts de la cola y del oráculo se fijan desde el IDL on-chain de Switchboard, como fixtures con cuentas reales de devnet.
- **Reveal:** `POST <gateway del oráculo>/gateway/api/v1/randomness_reveal` con `{ slothash, randomness_key, slot, rpc }`, que devuelve `{ signature, recovery_id, value }`. En `rpc` se envía **siempre la RPC pública de devnet**, nunca una RPC con API key.
- **Cuentas del reveal:** `stats = PDA(["OracleRandomnessStats", oracle])`, `program_state = PDA(["STATE"])` en el programa de Switchboard y `reward_escrow` = ATA de wSOL de la cuenta de randomness.
- El payload es público y cualquiera puede obtenerlo. La seguridad no depende de él: el programa lo verifica mediante la CPI (ADR 0002).

### 4.6 Ejecución

- `pnpm operator` compila `services/operator/main.ts` en un bundle Node con Vite en modo SSR (Vite ya está en el lockfile vía Vitest; pasa a ser devDependency directa, sin paquetes nuevos) y lo ejecuta con Node 24, leyendo `.env.operator` (ignorado por git; plantilla en `services/operator/operator.env.example`).
- `pnpm operator:e2e` ejecuta el jugador end-to-end de devnet (§12) con el mismo bundle.
- Logs en líneas JSON: ronda, fase, firma de la transacción, error y slot. Sin semillas no reveladas ni claves.

## 5. Web — datos en vivo

- **Fuentes:** una sola consulta `getMultipleAccounts` por segundo con `HouseConfig`, la `Round` más reciente, la `Player` del usuario y los saldos de su wallet y de su clave de sesión; el `slot` sale del contexto de la respuesta. Sin WebSocket: en la práctica, la RPC pública devolvía 429 a las suscripciones. Si las consultas fallan más de 5 s, el feed se marca `stale`, y un 429 de la RPC se muestra como `rate-limited`, no como caída.
- **Estado autoritativo:** solo las cuentas leídas con compromiso `confirmed`. Lo que llega con `processed` se muestra como "pendiente".
- **Multiplicador en vivo (proyección):** `tick = slot_actual − start_slot` y `multiplierAtTick(CRASH_RULES_V1, tick)`. Se etiqueta como estimado. El cliente no conoce el crash point hasta el `reveal`: hasta entonces la curva sigue subiendo, aunque ya haya pasado el crash.
- **Fin de ronda:** el crash point que se muestra es siempre `Round.crash_point` tras el `reveal`. Una ronda `Voided` o `Forfeited` se muestra como tal, con su efecto en la apuesta (reembolso o pago según la regla).
- **Ronda anterior sin revelar mientras corre el reloj:** la UI nunca muestra una ganancia como definitiva antes de `settle_bet` (o de verla reflejada en `Player.balance`).

## 6. Web — cuentas de jugador y apuestas

### 6.1 Monedas

- 1 moneda = 10⁶ lamports y se muestra con hasta 6 decimales. La entrada del usuario se convierte a lamports con aritmética entera sobre el texto (sin `number` ni `parseFloat`). Se rechazan más de 6 decimales.

### 6.2 Flujos

| Flujo | Transacción | Firma |
| --- | --- | --- |
| Alta | `register_player(nombre)` + `buy_coins` + `create_session` | Wallet |
| Abrir o renovar sesión | [transferencia de la clave anterior al dueño] + `create_session` | Wallet (y la clave anterior, si existe) |
| Comprar | `buy_coins` [+ `create_session` con la misma clave, tope = nuevo saldo, `spent` a 0 y, si le queda poco, recarga del fee budget] | Wallet |
| Apostar | [`settle_bet` de la apuesta anterior] + `place_bet(round_id, stake, auto)` | Clave de sesión (también paga la comisión) |
| Cash-out | `cash_out` | Clave de sesión |
| Salir | [`settle_bet`] + `revoke_session` + `sell_coins(balance)` + transferencia de la clave al dueño | Wallet y clave de sesión |

- **Nombre:** se valida en el cliente con las mismas reglas que el programa (`[a-z0-9_]`, 3–16) y se comprueba que el `UsernameRecord` no exista antes de firmar. El programa sigue siendo quien decide.
- **Valores por defecto de la sesión:** 216 000 slots (≈ 24 h), `spend_cap` = saldo tras la compra y `fee_budget` = 0.01 SOL (spec v2 §6). El usuario puede cambiar `spend_cap`.
- **Auto cash-out:** multiplicador opcional con 2 decimales (`≥ 1.01x`, `≤` máximo de las reglas), convertido a diezmilésimas. Lo aplica el programa al liquidar: no necesita transacción. Cuando el multiplicador estimado alcanza el auto cash-out, la web deja de ofrecer el cash-out manual (el automático gana cualquier empate o cash-out posterior, reglas §6) y lo indica como "alcanzado (estimado)", sin darlo por ganado hasta el `reveal`.
- **Validación previa:** antes de firmar se aplican `validateBet` y los límites de `HouseConfig`, y se comprueba que la sesión no esté caducada ni agote el tope. Un error del programa se muestra con su nombre (`BettingClosed`, `SessionSpendCapExceeded`…), nunca como éxito.

### 6.3 Clave de sesión en el navegador

- Se genera en el navegador con `Keypair.generate()` y se guarda en `localStorage` con la clave `crashit:session:<program_id>:<owner>`. Nunca sale del navegador.
- Al cargar, solo se usa si coincide con `Player.session.key`. Si no coincide o ha caducado, la UI ofrece renovarla y no intenta apostar.
- Pérdida máxima si se roba (XSS, extensión): `spend_cap` apostado + `fee_budget` (spec v2 §9). La UI muestra el tope, lo gastado y la caducidad, y un botón para revocarla.

### 6.4 Estados de una acción

`preparada → enviada (firma) → confirmada | rechazada (error del programa) | caducada (blockhash)`. El saldo y la apuesta que se muestran salen siempre de `Player` confirmada, nunca del resultado esperado de la transacción.

## 7. Web — History

- **Rondas:** las últimas 20 `Round` por id (desde `next_round_id − 1`, con `getMultipleAccountsInfo`). Muestra fase, crash point, número de apuestas y un enlace a Fairness.
- **Mis apuestas:** las últimas 20 firmas de la PDA `Player` del usuario, con los eventos `BetSettled` decodificados. Muestra ronda, stake, auto, tick de cash-out, resultado, multiplicador y pago. Las transacciones se piden de una en una y con reintentos: la RPC pública rechaza la forma por lotes.
- Es una proyección sin caché propia: si la RPC falla, se indica y no se muestran datos parciales como completos.

## 8. Web — Fairness

`/fairness?round=<id>` lee la `Round` y, en el navegador, con Web Crypto y el motor TS:
1. comprueba `commit = SHA256("crash/v1/commit" ‖ program_id ‖ round_id_le ‖ seed)`;
2. calcula `entropy = SHA256("crash/v1/entropy" ‖ program_id ‖ round_id_le ‖ seed ‖ vrf_output)`;
3. obtiene `crashPointFromEntropy(entropy, reglas de rules_version)` y `crashTick`, y los compara con `Round.crash_point` y `Round.crash_tick`;
4. muestra cada dato de entrada (hex), cada paso con su resultado (coincide o no coincide) y el `seed_slot` y la cuenta de Switchboard.

- **No verificable** (se indica de forma visible): rondas en `Betting`, `AwaitingEntropy` o `Running` (todavía sin semilla), `Voided` (sin resultado; reembolso) y `Forfeited` (sin semilla; se liquidó con la regla de forfeit).
- **Límite declarado:** el verificador comprueba que `vrf_output` es el que guardó el programa, no la firma del oráculo. Esa la verificó Switchboard en la CPI de `start_round` (ADR 0002, riesgo residual).
- La lógica de verificación vive en `games/crash/fairness` y recibe bytes. No sabe de Solana, así que sirve también para un verificador fuera de la web.

## 9. Invariantes y criterios de aceptación

1. **El cliente nunca es autoridad:** saldo, apuesta, crash point y resultado que se muestran salen de cuentas `confirmed` o de eventos del programa. Las proyecciones (multiplicador en vivo) se etiquetan como tales.
2. **Sin punto flotante** en importes ni multiplicadores, tanto en el codec como en los formularios y el crank.
3. **Codec fiel:** cada instrucción coincide con el IDL en discriminador, orden y flags de cuentas y en la codificación de argumentos. Cada decodificador rechaza un owner, discriminador o longitud incorrectos.
4. **Semilla secreta:** ninguna semilla no revelada sale del proceso del crank (ni en logs, ni en errores, ni en red) salvo en `reveal`.
5. **La semilla sobrevive** a un reinicio en cualquier punto del ciclo (§4.3).
6. **Toda ronda abierta termina** en `Crashed`/`Settled`, `Voided` o `Forfeited`, y toda apuesta acaba liquidada por el crank o por el propio jugador.
7. **Fairness reproduce** el crash point de cada ronda revelada; los vectores `crash-rules-v1.json` y rondas reales de devnet actúan como fixtures.
8. **Ninguna ruta de la web ni del crank firma con la wallet del usuario** fuera de los flujos de §6.2, ni con la clave de sesión fuera de `place_bet`, `settle_bet`, `cash_out`, `revoke_session` y la transferencia de salida.
9. **Límites de dependencias** (§2) comprobados por ESLint o por revisión.

## 10. Amenazas y supuestos

| Amenaza o supuesto | Tratamiento |
| --- | --- |
| XSS o extensión que roba la clave de sesión | Pérdida acotada por `spend_cap` + `fee_budget`; revocación visible. Sin HTML dinámico sin escapar, sin scripts de terceros |
| RPC maliciosa o caída | Solo devnet (genesis hash). Puede ocultar o retrasar estado, no falsificar el resultado: las transacciones las valida el programa. La UI muestra el estado de conexión |
| RPC que bloquea el crank (GHSA-528h-pc64-c93x en `stream-json`, vía `jayson`) | Solo afecta a la liveness: el crank usa una RPC de confianza. Se documenta y se revisará al migrar de `web3.js` v1 |
| Operador conoce el crash point durante la ronda | Riesgo residual aceptado (ADR 0002); no cambia |
| Pérdida de la semilla | `forfeit` penaliza a la casa; mitigado por `fsync` y recuperación |
| Caída del crank | La seguridad se mantiene: void/forfeit sin permisos tras los plazos, y liquidación por el jugador en su siguiente apuesta |
| API key de la RPC filtrada al oráculo | El gateway recibe siempre la RPC pública |
| Keypair del operador en el repo | El crank se niega a arrancar con rutas dentro del repo; `.gitignore` sin cambios de riesgo |
| Doble envío de una transacción | Todas las instrucciones son idempotentes o fallan sin efectos (`InvalidPhase`, `NoActiveBet`, `ActiveBetPending`) |

## 11. Decisiones pendientes de aprobación

| # | Decisión | Propuesta |
| --- | --- | --- |
| 1 | Switchboard off-chain en el crank | Adaptador propio (§4.5), sin el SDK. Alternativa: `@switchboard-xyz/on-demand` solo en el crank, que arrastra `@coral-xyz/anchor` 0.31, `axios` y otras ~15 dependencias directas a un proceso que custodia la clave del operador |
| 2 | Cómo se ejecuta el crank | Bundle con Vite (SSR) + Node 24 (§4.6). Alternativa: `tsx`, que añade `esbuild` con script de instalación |
| 3 | Dónde vive el crank | `services/operator/` en la raíz, fuera de `src/`, que es la app web |
| 4 | Idioma de la UI | Inglés, como la interfaz actual, hasta que se definan los requisitos de localización |
| 5 | Pausa entre rondas | 3 s tras la liquidación, configurable en el crank |
| 6 | Priority fee del crank | 1 000 micro-lamports/CU, configurable |
| 7 | Límites de la casa de devnet | Sin cambios: stake de 1–2 monedas, pago máximo de 200 y exposición de 500 por ronda |

## 12. Pruebas previstas

- **Codec (Vitest):** discriminadores, cuentas y argumentos contra el IDL; decodificación de cuentas reales de devnet guardadas como fixtures (`HouseConfig`, `Round` revelada, `Player`); rechazo de owner, discriminador o longitud incorrectos; eventos `BetSettled` de una transacción real.
- **Fairness:** los vectores v1 (commit, entropía y crash point) y al menos 3 rondas reales de devnet; casos no verificables.
- **Monedas:** conversión texto ↔ lamports en los límites (0, 6 decimales, 7 decimales rechazados, máximos `u64`).
- **Crank:** la máquina de estados como funciones puras (estado on-chain + semilla → siguiente acción), con todos los casos de §4.3; la custodia de semillas en un directorio temporal; la negativa a arrancar con rutas dentro del repo.
- **Switchboard off-chain:** parser de la cola y del oráculo contra cuentas reales de devnet; construcción del reveal contra el IDL fijado.
- **UI (Testing Library):** estados del panel de apuesta (sin wallet, sin cuenta, sesión caducada, apuesta pendiente, ronda `Running`), formulario de alta y validación del nombre, y la página de Fairness con una ronda válida y otra manipulada.
- **End-to-end en devnet (manual, documentado):** el crank corriendo al menos 20 rondas seguidas y un jugador desde la web que se da de alta, apuesta con cash-out manual y automático y sale. Fairness verifica todas las rondas reveladas y 0 discrepancias entre el saldo final y la suma de eventos.

## 13. Estado de la implementación (2026-09-29)

- **Código:**
  - codec y adaptador Solana en `src/chain-adapters/solana/crash-program/`, con el IDL versionado en `idl/crash.json`;
  - Switchboard off-chain en `src/chain-adapters/solana/switchboard/`;
  - verificador en `src/games/crash/fairness/`;
  - puertos y vistas en `src/games/crash/ui/` y `src/platform/player-accounts/`;
  - composición en `src/app/(dashboard)/crash-runtime.tsx`;
  - crank y jugador E2E en `services/operator/`.
- **Pruebas (Vitest, 220 en total):**
  - codec contra el IDL y contra cuentas y logs reales de devnet;
  - el verificador reproduce las 9 rondas reveladas de la prueba de v2;
  - offsets de Switchboard recalculados desde su IDL on-chain, y las listas de cuentas de `close_betting` y `start_round` de una ronda real reconstruidas byte a byte;
  - máquina de estados del crank con todos los casos de §4.3, custodia de semillas y configuración;
  - UI de apuesta, de cuenta y de Fairness con puertos simulados.
- **Devnet:**
  - **Crank:** rondas 11–41 sin intervención, cada `reveal` comprobado contra el cálculo del propio operador. Se mató el proceso a mitad de ronda y, al reiniciar, reanudó con la semilla guardada.
  - **Jugador E2E (`pnpm operator:e2e`):**
    - alta con una firma;
    - 7 apuestas firmadas por la clave de sesión (cash-out manual, auto a 1.50x y sin cash-out), liquidadas por el crank con **0 discrepancias** frente al motor;
    - todas las rondas verificadas con §8;
    - salida completa con 0 monedas.
  - **Aleatoriedad:** ninguna semilla ni `vrf_output` se repite entre las rondas 0–39. Los crash points iguales de las rondas 15/16 y 30/31 son coincidencias, y sus entradas son distintas.
  - **Navegador:** se comprobó en Edge headless que Crash muestra la ronda en vivo y las rondas recientes. **No se ha probado con una wallet real de navegador**: queda para el usuario (Phantom o Solflare en devnet).
- **Hallazgos:**
  - La RPC pública devuelve 429 con facilidad. Por eso la web consulta cada segundo en una sola petición, sin WebSocket; la confirmación se hace por sondeo; History pide las transacciones de una en una; y la salud de la RPC distingue `rate-limited` de `unreachable`. Conviene una RPC propia (`NEXT_PUBLIC_SOLANA_RPC_URL`, `CRASH_OPERATOR_RPC_URL`).
  - `confirmTransaction` de web3.js dejó un rechazo sin capturar que tumbó el crank. Resuelto con la confirmación por sondeo; además, los rechazos no capturados se registran sin detener el bucle.
  - **Coste del crank:** cada ronda crea una cuenta `Round` de 228 bytes con 1 808 480 lamports de rent (≈ 0.0018 SOL) que no se recupera, porque el programa no tiene `close_round`. A unos 40 s por ronda son ≈ 0.16 SOL/hora más comisiones. Recuperarlo exige un cambio del programa (decisión pendiente).
  - Dos ejecuciones del jugador E2E, antes de hacerlo reanudable, dejaron claves desechables inaccesibles con ≈ 0.093 SOL de devnet. Ahora las claves se guardan en `CRASH_OPERATOR_STATE_DIR` y solo se borran cuando la devolución al operador se confirma.
