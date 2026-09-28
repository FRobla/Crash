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
