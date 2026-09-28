# Checklist

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
- [ ] Medición en devnet — **bloqueada**: el faucet rechazó el airdrop (límite de peticiones); requiere fondear la dirección de desarrollo
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
