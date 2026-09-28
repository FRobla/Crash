# Changelog

## 2026-09-28

- Se establecieron las convenciones iniciales del proyecto: SSD spec-first/spec-anchored, organización por capacidades de negocio, revisión de seguridad en cada cambio y registro de cambios importantes.
- Se documentó la prioridad de arquitectura, funcionalidad y legibilidad, con una dirección visual oscura inspirada en terminales.
- Se estableció `en-US` como idioma obligatorio para código, identificadores, comentarios, docstrings y nombres de pruebas; la interfaz seguirá los requisitos de localización del producto.
- Se creó la base de la web app: Next.js 16 (App Router), React 19, TypeScript estricto, Tailwind CSS v4, ESLint y Vitest + Testing Library, gestionada con pnpm. Estructura por capacidades: `app/`, `platform/`, `games/crash/` y `chain-adapters/solana/`.
- Primer diseño de dashboard (sidebar + consola, tema oscuro de terminal) con Crash, History, Fairness y Bank. No hay lógica de juego, apuestas, randomness ni fondos: el panel de apuesta está deshabilitado y no se muestran datos ficticios.
- Integración inicial con Solana **devnet** únicamente: conexión de wallet de solo lectura (Wallet Standard, sin firmas ni transacciones), RPC configurable solo por https y comprobación del genesis hash que marca cualquier endpoint que no sea devnet.
- `next dev` mantiene en `CLAUDE.md` un bloque gestionado (`nextjs-agent-rules`) que obliga a consultar la documentación de Next.js incluida en `node_modules/next/dist/docs/`; se conserva para evitar diffs recurrentes (se desactiva con `agentRules: false`).
- Registrar en el changelog pasa a ser requisito para dar por terminado cualquier cambio importante.
- `CLAUDE.md` recoge los requisitos del MVP que guiarán las especificaciones: producto (Solana, SOL/USDC, Crash, house bank, web app en tiempo real), reglas de Crash, ciclo provably fair, house bank y riesgo (house edge objetivo cercano al 3%, pendiente de validación matemática), seguridad y manejo de fondos, y revisión de seguridad obligatoria en cada cambio.
- `CLAUDE.md` documenta el stack, los comandos (`pnpm dev`, `build`, `lint`, `typecheck`, `test`, ejecución de una sola prueba y `audit`), la estructura actual y los límites de dependencias: `games/*` y `platform/*` no importan de `chain-adapters/*`; la composición ocurre en `src/app`.
- Navegación del dashboard: `/` redirige a `/crash`; History, Fairness y Bank aparecen como secciones "soon" sin funcionalidad. La barra de estado muestra cadena, salud del RPC y estado de la wallet. El nombre provisional `[TEST]` está centralizado en `src/platform/product.ts`.
- Seguridad de la base: los scripts de instalación de `bufferutil`, `utf-8-validate`, `sharp` y `unrs-resolver` están denegados en `pnpm-workspace.yaml`; los archivos `.env*` se ignoran salvo `.env.example`; la UI solo muestra el host del RPC y los errores de configuración nunca incluyen la URL.
- Riesgo conocido: `pnpm audit` reporta 2 vulnerabilidades moderadas transitivas vía `@solana/web3.js` v1 → `jayson` (`uuid`, GHSA-w5hq-g745-h8pq; `stream-json`, GHSA-528h-pc64-c93x). No se aplican overrides porque exigen saltos de versión mayor; revisar antes de usar `web3.js` en el servidor.
- Pruebas iniciales (Vitest): configuración de Solana, clasificación de la salud del RPC, panel de apuesta deshabilitado y navegación activa del sidebar. Todavía no hay pruebas E2E.
- Primera especificación del juego, [`docs/specs/crash-round-rules.md`](docs/specs/crash-round-rules.md), en estado de borrador. Define:
  - el ciclo de vida de la ronda;
  - las unidades: importes `bigint` en unidades base y multiplicador en diezmilésimas;
  - una curva de multiplicador entera y determinista;
  - la derivación del crash point a partir de 32 bytes de entropía, con un RTP exacto de `1 − edge` demostrado para cualquier objetivo;
  - una regla única de victoria (`1.01x ≤ m ≤ crashPoint`) que no depende del orden de llegada;
  - límites de apuesta y de exposición;
  - 11 invariantes que actúan como criterios de aceptación.

  Los parámetros económicos quedan como *propuestos* (edge 3 %, +2.4 %/tick, cap 100x) y no están aprobados.
- ADRs propuestos, pendientes de aceptación y sin código que dependa de ellos:
  - [0001 — autoridad de settlement](docs/adr/0001-settlement-authority.md): recomienda un programa on-chain en el que tick = slot. Eso introduciría Rust y un framework de programas.
  - [0002 — randomness](docs/adr/0002-randomness-source.md): recomienda una semilla comprometida combinada con un VRF solicitado al cerrar las apuestas. Documenta que el crash point debe ser secreto durante la ronda y que una no revelación tras empezar se liquida con una regla penalizadora (`forfeit`), nunca con un reembolso. Declara como riesgo residual la posible colusión entre operador y jugador.
- Motor puro de Crash en `src/games/crash/domain/`: curva, crash point, límites, liquidación (`settleRound`, `refundRound`, `settleForfeitedRound`) y ciclo de vida. No depende de la cadena, de la UI ni de ningún proveedor.
  - Todavía no está conectado a la UI, a fondos ni a una fuente real de randomness.
  - El house edge solo está validado en el modelo matemático.
- Pruebas del motor: RTP exacto sin Monte Carlo y pruebas de propiedades con `fast-check` (nueva devDependency, sin install scripts). Las propiedades cubren pago acotado por la exposición, independencia del orden, idempotencia, monotonía y que el forfeit nunca abarata la ronda al house.
- `tsconfig.json`: `target` pasa de ES2017 a ES2020 para admitir literales `bigint`. Solo afecta al typecheck (`noEmit`), porque el bundle lo transpila Next.js.
- **Iteración 2 — decisiones y preparación del programa on-chain.**
  - [ADR 0001](docs/adr/0001-settlement-authority.md) **aceptado**: la autoridad de settlement es un programa Solana construido con **Anchor**, y un tick equivale a un slot.
  - [ADR 0002](docs/adr/0002-randomness-source.md) **aceptado parcialmente**. Quedan aceptados el esquema de semilla comprometida + VRF, la regla `forfeit` y el riesgo residual de colusión para el MVP en devnet. El proveedor VRF (ORAO o Switchboard) queda pendiente de un [spike en devnet](docs/spikes/vrf-devnet.md), del que por ahora solo existe el método.
- Reglas **v1 aprobadas solo para devnet**: `CRASH_RULES_V1` (edge 3 %, +2.4 %/tick, cap 100x) en `src/games/crash/domain/rules.ts`.
  - Las versiones de reglas son inmutables; cambiar el algoritmo o los parámetros exige una versión nueva.
  - Antes de usar fondos reales se requiere una revisión de riesgo.
- Vectores de referencia [`docs/specs/vectors/crash-rules-v1.json`](docs/specs/vectors/crash-rules-v1.json), generados por el motor. Son la referencia que deben reproducir el programa en Rust y cualquier verificador independiente. Contienen:
  - la curva completa;
  - 60 crash points, incluidos los umbrales exactos;
  - 39 liquidaciones (reveal, forfeit y refund), con casos límite hechos a mano;
  - 11 casos de validación de apuestas.

  Una prueba golden file (`toMatchFileSnapshot`) falla si el JSON no coincide con el motor. No contienen secretos: toda la entropía sale de SHA-256 de etiquetas públicas.
- Spec del programa on-chain [`docs/specs/crash-program.md`](docs/specs/crash-program.md), en borrador y **pendiente de aprobación**. Todavía no hay código del programa. Define:
  - las cuentas: `HouseConfig`, `HouseVault`, `Round` y `Bet`;
  - 13 instrucciones con sus precondiciones;
  - 10 invariantes, la validación de cuentas y firmantes por instrucción y las amenazas.

  Reglas de seguridad destacadas:
  - un `reveal` solo se acepta cuando la curva ya alcanzó el crash point, así que nunca bloquea un cash-out ganador;
  - la pausa nunca bloquea las vías de salida;
  - un retiro del bank no puede tocar la exposición reservada.
- Toolchain on-chain instalado en WSL Ubuntu-24.04 desde fuentes oficiales: Rust 1.98.1, Solana CLI 4.3.0 (Agave) y Anchor 1.2.0 (avm 1.2.0).
  - Configurado contra devnet, con un keypair solo de desarrollo fuera del repo.
  - Versiones y uso documentados en `CLAUDE.md`.
- **Iteración 3 — programa on-chain (Anchor) y lógica pura en Rust.**
  - [Spec del programa](docs/specs/crash-program.md) **aprobada (v1.0)**. Decisiones de la §12:
    - timeouts de 25/150/150 slots;
    - 256 apuestas por ronda;
    - un *crank* del operador;
    - priority fees a cargo del jugador;
    - workspace en `programs/solana/`.

    El proveedor VRF sigue abierto.
  - Nuevo workspace Anchor 1.2 en `programs/solana/`, solo Rust y sin toolchain JS propio.
- `crates/crash-rules`: las reglas v1 en Rust puro (`no_std`, sin Anchor).
  - **Reproduce exactamente** `docs/specs/vectors/crash-rules-v1.json`: curva, crash points, 39 liquidaciones y validación de apuestas.
  - Tiene pruebas de propiedades (`proptest`) con los mismos invariantes que el motor TypeScript.
- Programa `crash`: implementa las cuentas `HouseConfig`, `HouseVault`, `Round` y `Bet`, 14 instrucciones y los eventos. `start_round` y la solicitud del VRF devuelven `EntropyProviderNotConfigured` hasta cerrar el spike. Reglas de seguridad añadidas o precisadas en la spec durante la implementación:
  - `initialize_house` exige ser la autoridad de upgrade del programa, para que nadie pueda adelantarse y quedarse con el rol de admin;
  - `reveal` solo se acepta hasta `reveal_deadline_slot`, y a partir de ahí solo cabe `forfeit`, así el resultado nunca depende de una carrera;
  - la exposición se reserva en cada apuesta y la solvencia se comprueba en la cadena;
  - los pagos solo pueden ir a `bet.player`;
  - la pausa nunca bloquea las vías de salida.
- Pruebas LiteSVM del programa (9 escenarios):
  - flujos revelado, forfeit y void;
  - límites y exposición;
  - inicio de la casa reservado a la autoridad de upgrade;
  - pausa;
  - casos adversariales: pago a otra cuenta, cash-out ajeno, doble liquidación y reveal temprano o con semilla falsa.

  La solvencia del vault se verifica tras cada transacción. Para llegar a `Running` sin VRF, las pruebas escriben la cuenta de ronda directamente; el programa desplegable no contiene ningún atajo equivalente.
- Compatibilidad del toolchain:
  - la plantilla de Anchor 1.2 fija LiteSVM 0.10, que **no carga programas SBPF v3**; se usa LiteSVM 0.17 (Agave 4.3);
  - `rust-toolchain.toml` pasa a rustc 1.98.1, porque Agave 4.3 exige al menos 1.97.1;
  - la compilación se hace fuera de `/mnt/c` (`CARGO_TARGET_DIR`), así el keypair del programa nunca entra en el repo;
  - `cargo clippy` queda sin avisos y `cargo fmt` aplicado.
- [Spike VRF](docs/spikes/vrf-devnet.md), fase 1:
  - **ORAO 0.7.0 no compila junto a Anchor 1.2** (fija `anchor-lang 0.32.1`), así que queda descartado como crate;
  - **Switchboard On-Demand 0.13.0 sí compila** con la feature `solana-v3`.

  La fase 2 (medición en devnet) está bloqueada porque el faucet rechazó el airdrop por límite de peticiones.
- No se ejecutó `cargo audit` porque no está instalado en el toolchain.
- **Iteración 4 — spike del VRF en devnet** ([resultados](docs/spikes/vrf-devnet.md)).
  - **Switchboard On-Demand**: 100 de 100 rondas commit → reveal correctas en devnet. Latencia p50 de 18 slots, p95 de 28 y máximo de 30. Cuesta 10 000 lamports por ronda (sin tarifa de oráculo) más un rent único de unos 0.003 SOL por la cuenta de randomness.
  - La cuenta de desarrollo de la CLI (`3R48…`) la fondeó el usuario desde su wallet de desarrollo (`DUfB…`). Ninguna clave privada pasó por el chat.
  - El cliente de medición se ejecutó fuera del repo y no se incorporó.
- Hallazgo de seguridad: en Switchboard, el reveal exige la firma de la authority de la cuenta de randomness, y el payload del reveal lo puede obtener **cualquiera** desde el gateway (verificado con un tercero). Si la authority fuese el operador, este conocería el crash point antes de iniciar la ronda y podría forzar un reembolso, que es una opción gratuita contra el jugador. **Propuesta en ADR 0002, pendiente de aceptación:**
  - la authority pasa a ser una PDA del programa;
  - el commit se hace por CPI en `close_betting` y el reveal por CPI en `start_round`, ambas sin permisos;
  - se añade una anulación sin permisos para las rondas que se queden bloqueadas en `Betting`.
- Riesgos de integración anotados:
  - el crate no incluye CPI de reveal, así que habrá que construirla a mano;
  - `RandomnessAccountData::parse` no comprueba el owner;
  - el valor solo se puede leer en el mismo slot del reveal.

  El modelo de confianza (TEE + oráculo, sin prueba VRF matemática) queda declarado como riesgo residual.
