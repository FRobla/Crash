# Checklist — Spec y motor puro de Crash + ADRs

Iteración iniciada el 2026-09-28. Marca cada paso al completarlo.

## 0. Preparación
- [x] Revisar convenciones locales (tsconfig, eslint, vitest, estilo de pruebas existentes)
- [x] Añadir `fast-check` como devDependency con pnpm y comprobar que no ejecuta install scripts

## 1. ADRs (propuestos, no aceptados)
- [x] `docs/adr/0001-settlement-authority.md` — opciones A/B/C, criterios, recomendación preliminar
- [x] `docs/adr/0002-randomness-source.md` — secreto hasta fin de ronda, opciones, amenazas, supuestos residuales

## 2. Spec
- [x] `docs/specs/crash-round-rules.md` — ciclo de vida, unidades, curva, crash point, regla única de victoria, pago, límites, invariantes, decisiones abiertas

## 3. Motor puro (`src/games/crash/domain/`)
- [x] `units.ts` + pruebas
- [x] `multiplier-curve.ts` + pruebas (monotonía, golden values)
- [x] `crash-point.ts` + pruebas (RTP analítico exacto, 1.00x, cap, bordes de `r`, entropía inválida)
- [x] `limits.ts` + pruebas (bordes ±1 unidad base, exposición)
- [x] `settle-round.ts` + pruebas de propiedades (pago acotado, regla `m ≤ crash`, permutación, duplicados, exposición, void)
- [x] `round-lifecycle.ts` + pruebas (transiciones inválidas, apuestas fuera de `Betting`)

## 4. Verificación
- [x] `pnpm test`
- [x] `pnpm lint`
- [x] `pnpm typecheck`
- [x] `pnpm audit`

## 5. Revisión de seguridad
- [x] Ningún `number` para importes en `domain/`
- [x] `domain/` no importa de `chain-adapters`, React ni Next
- [x] Sin secretos ni semillas reales en pruebas o docs

## 6. Documentación
- [x] `CLAUDE.md` — estructura actual (`docs/specs`, `docs/adr`, `games/crash/domain`)
- [x] `changelog.md` — entrada fechada 2026-09-28

## 7. Cierre
- [x] Informe final: qué se hizo, qué no se verificó, decisiones pendientes del usuario (aceptar ADRs, parámetros abiertos)
