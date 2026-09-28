# Changelog

## 2026-09-28

- Se establecieron las convenciones iniciales del proyecto: SSD spec-first/spec-anchored, organización por capacidades de negocio, revisión de seguridad en cada cambio y registro de cambios importantes.
- Se documentó la prioridad de arquitectura, funcionalidad y legibilidad, con una dirección visual oscura inspirada en terminales.
- Se estableció `en-US` como idioma obligatorio para código, identificadores, comentarios, docstrings y nombres de pruebas; la interfaz seguirá los requisitos de localización del producto.
- Se creó la base de la web app: Next.js 16 (App Router), React 19, TypeScript estricto, Tailwind CSS v4, ESLint y Vitest + Testing Library, gestionada con pnpm. Estructura por capacidades: `app/`, `platform/`, `games/crash/` y `chain-adapters/solana/`.
- Primer diseño de dashboard (sidebar + consola, tema oscuro de terminal) con Crash, History, Fairness y Bank. No hay lógica de juego, apuestas, randomness ni fondos: el panel de apuesta está deshabilitado y no se muestran datos ficticios.
- Integración inicial con Solana **devnet** únicamente: conexión de wallet de solo lectura (Wallet Standard, sin firmas ni transacciones), RPC configurable solo por https y comprobación del genesis hash que marca cualquier endpoint que no sea devnet.