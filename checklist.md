# Checklist

## Iteración 8 — Versión funcional mínima (crank, web, History y Fairness)

Iniciada el 2026-09-29. Revisión previa: JS (151 pruebas, lint, typecheck) y Rust (38 pruebas, fmt) en verde; `pnpm audit` con las 2 moderadas conocidas. Decisiones del usuario: crank en Node dentro del repo, clave de sesión en `localStorage`, codec propio sin el cliente TS de Anchor, alcance Crash + Fairness + History.

### 0. Cabos sueltos
- [x] Estados de las specs corregidos: v1.1 → histórico, v2 → vigente (`crash-program.md`, `crash-program-v2.md`, `CLAUDE.md`)
- [x] Commit de la iteración 7 (lo gestiona el usuario)
- [ ] Aplazados, sin bloquear esta iteración: spec de progresión (`PROGRESSION_V1`) y ADR del chat (iteración 7, §3)

### 1. Spec (spec-first)
- [x] `docs/specs/crash-client-v1.md` redactada: codec, crank, web, History, Fairness, invariantes, amenazas
- [x] Aprobación de la spec y de las decisiones de su §11 (2026-09-29)

### 2. Implementación
- [x] IDL versionado y codec TS con pruebas contra el IDL y cuentas reales de devnet
- [x] `games/crash/fairness` con rondas reales (reproduce las 9 rondas reveladas de v2)
- [x] Adaptador off-chain de Switchboard (oráculo, gateway) con fixtures reales
- [x] Crank en `services/operator/`: máquina de estados pura, custodia de semillas, recuperación
- [x] Web: ronda en vivo, alta/compra/sesión, apuesta, cash-out, salida
- [x] Web: History y Fairness

### 3. Verificación y seguridad
- [x] `corepack pnpm test` (220), `lint`, `typecheck`, `build`, `audit` (2 moderadas conocidas); Rust sin cambios (38 en verde al inicio)
- [x] Revisión de seguridad (§10 de la spec): semillas fuera del repo y nunca en logs, claves solo por ruta fuera del repo, límites de dependencias, firmantes por flujo, RPC pública en el gateway, sin secretos en fixtures
- [x] End-to-end en devnet: crank en las rondas 11–41 (con reinicio a mitad de ronda) y jugador automatizado con los mismos builders que la web: 7 apuestas, 0 discrepancias
- [ ] Prueba manual de la web con una wallet de navegador real en devnet (usuario)
- [x] Robustez frente a los 429 de la RPC pública: confirmación por sondeo (web y crank), rechazos no capturados registrados en el crank, History con peticiones secuenciales y reintentos
- [x] Comprobación de aleatoriedad: ninguna semilla ni VRF repetidos en las rondas 0–39 (los crash points iguales de 15/16 y 30/31 son coincidencia)
- [x] Jugador E2E reanudable: claves desechables guardadas hasta que se confirma la devolución (antes se perdieron ≈ 0.093 SOL de devnet)
- [x] Coste de alta en la UI calculado con el rent real de la RPC

### 4. Documentación
- [x] `CLAUDE.md` (estructura, comandos del crank, límites), `changelog.md`, spec §13

### 5. Pendiente (decisión del usuario)
- [ ] ¿Recuperar el rent de cada `Round` (≈ 0.0018 SOL) con una instrucción `close_round`? Exige un cambio del programa (spec v2.1)
- [ ] RPC propia para la web y el crank (la pública limita la tasa)

### 6. Estado al cerrar la sesión (2026-09-29)
- Crank parado. La ronda 41 quedó abierta con su semilla guardada en `CRASH_OPERATOR_STATE_DIR`: el próximo `pnpm operator` la retoma o la anula sin pérdidas
- Saldo del operador `3R48…`: 2.21 SOL; bank de la casa: 0.306 SOL
- Iteraciones 7 y 8 sin commitear (lo gestiona el usuario)

---

## Iteración 7 — Cuentas de jugador, monedas y sesiones (ADR 0003)

Iniciada el 2026-09-28. Decisiones del usuario: opción A (saldo on-chain + clave de sesión), nombre de usuario on-chain, el nivel dará ventajas en el futuro, sin comisión de compra/venta, chat con base de datos (ADR aparte).

### 1. Decisión (spec-first)
- [x] ADR 0003 redactado (propuesto)
- [x] Aceptación del usuario y respuesta a las preguntas abiertas del ADR (2026-09-29)
- [x] Spec del programa v2 redactada (`docs/specs/crash-program-v2.md`): `Player`, `UsernameRecord`, sesiones, apuesta embebida, invariantes, validación de cuentas y firmantes, migración
- [x] Aprobación de la spec v2 (decisiones de su §14), 2026-09-29

### 2. Implementación
- [x] Program id nuevo para v2 (keypair de v1.1 guardado fuera del repo)
- [x] Cuentas `Player`, `UsernameRecord` y `PlayerPolicy`; se eliminan `Bet` y `close_bet`
- [x] Instrucciones de jugador y sesión; `place_bet`, `cash_out` y `settle_bet` sobre el saldo
- [x] Pruebas LiteSVM (19) con invariantes tras cada transacción; `cargo test`, `clippy` y `fmt`
- [x] Revisión de seguridad: firmantes por instrucción (§4 y §8), destinos de fondos, pausa, reentrada (sin CPIs nuevas salvo transferencias del System Program)
- [x] Documentación: spec v2 §15, `CLAUDE.md`, `changelog.md`

### 3. Pendiente
- [x] Despliegue en devnet según la spec v2 §13 (bank de v1.1 retirado; v2 en `DNmfJ…`, binario verificado) y prueba end-to-end con el Switchboard real (9 rondas reveladas, 19 liquidaciones sin discrepancias)
- [x] Timeouts ampliados en devnet (2026-09-29): `betting_slots` 25 → 50 y `entropy_timeout_slots` 150 → 300, con `update_config`
- [ ] Spec de progresión (`PROGRESSION_V1`) con vectores
- [ ] ADR del backend del chat (base de datos, hosting, WebSockets)

---

## Iteración 6 — Despliegue en devnet y prueba end-to-end con Switchboard real

Iniciada el 2026-09-28. El usuario elige `3R48JPhp8zkRokLdGJx8rFDT53CiKz92BYJErkipzpqV` (keypair de la CLI en WSL, solo devnet) como autoridad de upgrade, admin y operador.

### 1. Despliegue
- [x] `anchor build` limpio y `.so` idéntico al que se despliega (hash)
- [x] Saldo suficiente; `solana program deploy` con el keypair del programa (fuera del repo)
- [x] Verificar on-chain: autoridad de upgrade = `3R48…` y binario desplegado = local (hash)

### 2. End-to-end (cliente desechable fuera del repo)
- [x] `initialize_house` con límites pequeños de devnet; `deposit_bank`
- [x] `create_randomness_account` contra el Switchboard real (authority = PDA)
- [x] Ronda completa: `open_round` → `place_bet` → `close_betting` (commit real) → `start_round` (reveal real con payload del gateway) → `cash_out` → `reveal` → `settle_bet` → `close_bet`
- [x] Verificación independiente del crash point (fuera del programa) a partir de `seed`, `vrf_output`, `round_id` y `program_id`
- [x] Compute units reales de `close_betting` y `start_round`
- [x] Varias rondas para detectar fallos intermitentes

### 3. Seguridad
- [x] Ninguna clave privada impresa ni en el repo; la semilla de cada ronda no se muestra antes de `reveal`
- [x] Fondos del bank limitados al mínimo necesario en devnet

### 4. Documentación
- [x] Resultados en la spec del programa (§13) y en el spike (fase 3)
- [x] `CLAUDE.md` — program id desplegado en devnet y autoridad
- [x] `changelog.md` — entrada de la iteración 6

### 5. Pendiente (decisión del usuario)
- [x] ¿Ampliar `entropy_timeout_slots`? Sí: 300 desde el 2026-09-29 (iteración 7)

---

## Iteración 5 — Integración de Switchboard en el programa

Iniciada el 2026-09-28. El usuario acepta la propuesta de cierre de ADR 0002: Switchboard On-Demand, authority PDA, commit/reveal por CPI sin permisos y void sin permisos de rondas atascadas en `Betting`.

### 1. Decisiones y spec (spec-first)
- [x] ADR 0002 → aceptado
- [x] Spec del programa: cuenta de randomness de la casa, `create_randomness_account`, CPI de commit en `close_betting`, CPI de reveal en `start_round`, void sin permisos en `Betting`, validación de cuentas (§8), amenazas (§9), decisión 1 (§12)

### 2. Adaptador de Switchboard (sin añadir el crate)
- [x] `switchboard.rs`: program id fijado (devnet), discriminadores, lectura de la cuenta con owner + discriminador + longitud, builders de init/commit/reveal
- [x] Prueba: los builders coinciden con el IDL on-chain fijado (`tests/fixtures/switchboard-randomness-idl.json`)
- [x] Prueba: el parser lee la cuenta real de devnet (`tests/fixtures/switchboard-randomness-account-devnet.hex`)

### 3. Programa
- [x] `HouseConfig`: cuenta de randomness y bump de la authority PDA; `Round`: cuenta y `seed_slot`
- [x] `create_randomness_account` (admin, sin ronda activa): CPI de `randomness_init` firmada por la PDA; verificación posterior
- [x] `open_round` exige cuenta de randomness configurada
- [x] `close_betting`: CPI de `randomness_commit`; guarda cuenta y `seed_slot`
- [x] `start_round`: CPI de `randomness_reveal`, owner/cuenta/`seed_slot`/`reveal_slot` verificados, `slot ≤ entropy_deadline_slot`; → `Running`
- [x] `void_round`: sin permisos en `Betting` tras `betting_end_slot + entropy_timeout_slots`
- [x] Evento `RoundStarted`

### 4. Pruebas
- [x] Programa mock de Switchboard solo para pruebas (mismo IDL, sin verificación de firma del oráculo), cargado en LiteSVM en el PID de devnet
- [x] Sustituir `force_running` por el flujo real commit → reveal
- [x] Adversariales: cuenta de randomness ajena, programa de Switchboard falso, cuenta con owner falso, `seed_slot` de otra ronda, reveal tras el deadline, doble `start_round`
- [x] Void sin permisos en `Betting`
- [x] Compute units de `close_betting` y `start_round` (LiteSVM con el mock: 15 091 y 58 062; con el coste real de devnet, commit 15 109 y reveal 41 934, ambas < 200 000)

### 5. Verificación
- [x] `anchor build`, `cargo test`, `cargo clippy`, `cargo fmt --check`
- [x] `corepack pnpm test`, `lint`, `typecheck`

### 6. Revisión de seguridad
- [x] Checklist §8 de la spec aplicada a las instrucciones nuevas
- [x] El mock nunca se despliega ni entra en el binario del programa
- [x] Sin claves ni secretos en fixtures (solo datos públicos de devnet)

### 7. Documentación
- [x] `CLAUDE.md` — estructura y comandos (mock)
- [x] `changelog.md` — entrada de la iteración 5

### 8. Pendiente (siguiente iteración)
- [x] Prueba end-to-end en devnet contra el Switchboard real — hecha en la iteración 6

---

## Iteración 4 — Spike VRF en devnet (fase 2)

Iniciada el 2026-09-28. La wallet de desarrollo del usuario es `DUfBEagYErLiFnBk16QjR94pJJ3zPe1eQnTRHtfZQwZ4` (10.1 SOL de devnet). El usuario transfiere SOL al keypair de la CLI en WSL (`3R48JPhp8zkRokLdGJx8rFDT53CiKz92BYJErkipzpqV`); ninguna clave privada pasa por el chat.

### 1. Preparación
- [x] Revisar el SDK actual de Switchboard On-Demand (versión, flujo commit/reveal, cuentas, costes documentados)
- [x] Cliente de medición desechable fuera del repo (WSL), sin tocar lockfiles del repo
- [x] Verificar saldo de `3R48…` en devnet antes de medir

### 2. Medición (Switchboard On-Demand)
- [x] Latencia commit → reveal disponible (slots, p50/p95/máx)
- [x] Tasa de fallo (sin reveal antes de 150 slots)
- [x] Coste por ronda (lamports: rent no recuperable + comisiones + tarifa del oráculo)
- [x] Vinculación a la ronda y verificación on-chain (qué comprueba el programa consumidor)
- [x] Modelo de confianza documentado

### 3. Decisión
- [x] Resultados y recomendación en `docs/spikes/vrf-devnet.md`
- [x] Propuesta de cierre de ADR 0002 (pendiente de aceptación del usuario)

### 4. Verificación y seguridad
- [x] Nada del spike entra en el repo salvo la documentación
- [x] Sin claves ni semillas en logs, docs o repo
- [x] `corepack pnpm test`/`lint`/`typecheck` y `cargo test` siguen en verde

### 5. Documentación
- [x] `changelog.md` — entrada de la iteración 4

---

## Iteración 3 — Workspace Anchor, lógica pura en Rust y spike VRF

Iniciada el 2026-09-28. El usuario aprueba la spec del programa y las propuestas de su §12 (timeouts 25/150/150 slots, `max_bets_per_round = 256`, crank del operador, priority fees del jugador, workspace en `programs/solana/`).

### 1. Spec
- [x] `docs/specs/crash-program.md` → aprobada (v1.0); §12 resuelta salvo el proveedor VRF

### 2. Workspace
- [x] Inspeccionar la plantilla de `anchor init` 1.2.0 (versiones de crates, layout, pruebas)
- [x] `programs/solana/` sin toolchain JS propio (sin `package.json` ni lockfiles ajenos a pnpm)
- [x] Excluir `programs/` de `tsconfig`/ESLint si hace falta; `target/` en `.gitignore`
- [x] `anchor build` compila en WSL

### 3. Crate puro `crash-rules` (sin Anchor)
- [x] Curva, crash point, validación de apuestas, liquidación por apuesta, forfeit y refund
- [x] Pruebas que reproducen `docs/specs/vectors/crash-rules-v1.json` exactamente
- [x] Pruebas de propiedades de los invariantes principales

### 4. Programa `crash` (Anchor)
- [x] Cuentas `HouseConfig`, `HouseVault`, `Round`, `Bet`
- [x] Instrucciones de house: `initialize_house`, `update_config`, `deposit_bank`, `withdraw_bank`
- [x] Instrucciones de ronda sin VRF: `open_round`, `place_bet`, `close_betting`, `cash_out`, `reveal`, `settle_bet`, `void_round`, `forfeit_round`, `close_bet`
- [x] `start_round` / solicitud VRF: bloqueado por el spike (se documenta el hueco)
- [x] Eventos
- [x] Pruebas LiteSVM: flujo, errores, adversariales, invariante de solvencia

### 5. Spike VRF (fuera del repo, desechable)
- [x] Compatibilidad de crates de ORAO y Switchboard con Anchor 1.2
- [x] Medición en devnet — hecha en la iteración 4 (aquí quedó bloqueada por el límite del faucet; el usuario fondeó la dirección de desarrollo)
- [x] Resultados en `docs/spikes/vrf-devnet.md`

### 6. Verificación
- [x] `cargo test` / `anchor build` en WSL
- [x] `corepack pnpm test`, `lint`, `typecheck`, `audit`
- [x] `cargo audit`: no instalado; se informa (sí se ejecutaron `cargo clippy` sin avisos y `cargo fmt`)

### 7. Revisión de seguridad
- [x] Checklist §8 de la spec aplicada instrucción por instrucción
- [x] Sin claves, semillas ni keypairs en el repo
- [x] Sin puertas traseras de entropía en builds desplegables

### 8. Documentación
- [x] `CLAUDE.md` — estructura y comandos Rust
- [x] `changelog.md` — entrada de la iteración 3

### 9. Cierre
- [x] Informe final

---

## Iteración 2 — Decisiones, vectores compartidos y spec del programa on-chain

Iniciada el 2026-09-28. Decisiones del usuario: ADR 0001 aceptado con Anchor; ADR 0002 esquema C aceptado, proveedor VRF tras spike; parámetros v1 aprobados para devnet; git lo gestiona el usuario.

### 1. Registrar decisiones
- [x] ADR 0001 → aceptado (Anchor); preguntas abiertas vivas trasladadas a la spec del programa
- [x] ADR 0002 → aceptado parcialmente (esquema C + `forfeit`; proveedor pendiente del spike)
- [x] Spec de reglas: parámetros v1 aprobados para devnet + `rulesVersion`
- [x] `src/games/crash/domain/rules.ts` con `CRASH_RULES_V1` + pruebas

### 2. Vectores compartidos TS ↔ Rust
- [x] Generador determinista (sin dependencias nuevas)
- [x] `docs/specs/vectors/crash-rules-v1.json` (curva, crash points, liquidaciones, validación de apuestas)
- [x] Prueba golden file que falla si el JSON no coincide con el motor
- [x] Vectores sin secretos (entropía = SHA-256 de etiquetas públicas)

### 3. Spec del programa (sin código)
- [x] `docs/specs/crash-program.md`: alcance SOL, cuentas/PDAs, instrucciones con pre/postcondiciones, correspondencia con el motor, invariantes, amenazas, validación de cuentas/signers por instrucción, pruebas previstas, decisiones abiertas

### 4. Toolchain en WSL (Ubuntu-24.04)
- [x] `rustup` stable
- [x] Solana CLI (instalador oficial de Anza) → devnet
- [x] `avm` + Anchor (versión fijada)
- [x] Keypair solo de desarrollo, fuera del repo
- [x] Versiones anotadas en `CLAUDE.md`

### 5. Spike VRF (solo método)
- [x] `docs/spikes/vrf-devnet.md`: métricas, muestra, criterio de decisión

### 6. Verificación
- [x] `corepack pnpm test`
- [x] `corepack pnpm lint`
- [x] `corepack pnpm typecheck`
- [x] `corepack pnpm audit`
- [x] Toolchain: `rustc`, `solana`, `anchor --version`, `solana config get`

### 7. Revisión de seguridad
- [x] Sin secretos ni claves en repo, vectores o docs
- [x] Keypair de desarrollo fuera del repo y no referenciado por ruta absoluta en docs versionadas
- [x] Fuentes de instalación oficiales y versiones fijadas

### 8. Documentación
- [x] `CLAUDE.md` — estructura y toolchain
- [x] `changelog.md` — entrada de la iteración 2

### 9. Cierre
- [x] Informe final: hecho, no verificado, decisiones pendientes

---

## Iteración 1 — Spec y motor puro de Crash + ADRs (completada 2026-09-28)

- [x] Preparación: convenciones revisadas, `fast-check` añadido
- [x] ADRs 0001 y 0002 propuestos
- [x] Spec `docs/specs/crash-round-rules.md`
- [x] Motor puro en `src/games/crash/domain/` con pruebas (unidades, curva, crash point, límites, liquidación, ciclo de vida)
- [x] Verificación: test, lint, typecheck, audit
- [x] Revisión de seguridad y documentación (`CLAUDE.md`, `changelog.md`)
