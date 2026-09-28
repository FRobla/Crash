# Spike — Proveedor VRF en devnet

- Estado: **completado** (2026-09-28). La recomendación está pendiente de que el usuario la acepte en ADR 0002.
- Fecha: 2026-09-28
- Decide: la pregunta abierta 1 de [ADR 0002](../adr/0002-randomness-source.md) y la decisión 1 de la [spec del programa](../specs/crash-program.md).
- Candidatos: **ORAO VRF** y **Switchboard On-Demand**.

## Objetivo

Elegir el proveedor que entrega `vrf_output` para el esquema C con datos medidos en devnet, no con afirmaciones de documentación. El spike es **desechable**: su código no pasa al programa.

## Qué se mide

| Métrica | Cómo | Por qué importa |
| --- | --- | --- |
| Latencia de cumplimiento (slots) | `slot_cumplimiento − slot_solicitud`, p50/p95/máx | Es el tiempo muerto entre el cierre de apuestas y el inicio de la ronda. Fija `entropy_timeout_slots` |
| Tasa de fallo | Solicitudes no cumplidas antes de 150 slots | Cada fallo es una ronda anulada |
| Coste por solicitud | Lamports de la solicitud + comisiones + rent no recuperable | Coste operativo por ronda |
| Compute units | CUs de la CPI de solicitud y de la lectura/verificación | Encaje en `close_betting` y `start_round` |
| Integración | Cuentas necesarias, CPI desde Anchor 1.x, compatibilidad de versiones del SDK de Rust | Complejidad y superficie de ataque |
| Modelo de confianza | Quién produce la aleatoriedad (oráculo único, red, TEE), qué se verifica on-chain y qué puede sesgar | Riesgo residual de ADR 0002 |
| Vinculación a la ronda | Si la salida puede atarse a una semilla o cuenta por ronda y rechazarse si es previa al cierre | Requisito fijo de la spec §6 |

## Método

1. Programa Anchor mínimo en un directorio temporal, fuera del repo. Tiene dos instrucciones: `request(round_seed)` y `consume()`, que registran slots y salida.
2. Script cliente que lanza **100 solicitudes secuenciales por proveedor** repartidas en al menos dos franjas horarias. Registra slots, firmas, lamports y CUs.
3. Keypair solo de desarrollo, en WSL, con SOL de airdrop de devnet. Nunca se usan claves con fondos reales.
4. Resultados en una tabla en este documento, con los enlaces a las transacciones de muestra en el explorer de devnet.

## Criterio de decisión

1. **Descartar** cualquier proveedor que:
   - no permita vincular la salida a la ronda, o
   - tenga una tasa de fallo superior al 2 %, o
   - no sea compatible con Anchor 1.x sin forks.
2. Entre los restantes, elegir por este orden:
   1. modelo de confianza, cuanto menos confianza exija mejor;
   2. latencia p95;
   3. coste;
   4. simplicidad de integración.
3. Registrar la elección en ADR 0002, que pasará a *aceptado*, y concretar §6 y los timeouts de la spec del programa.

## Resultados

### Fase 1 — Compatibilidad con Anchor 1.2 (2026-09-28)

Se usó un crate desechable fuera del repo (`~/vrf-spike` en WSL), con `anchor-lang = 1.2.0` y rustc 1.98.1, comprobado con `cargo check` en el host.

| Proveedor | Crate | Dependencias relevantes | Resultado |
| --- | --- | --- | --- |
| ORAO | `orao-solana-vrf 0.7.0` (`default-features = false`, `cpi`) | Fija `anchor-lang = 0.32.1` (también `anchor-client` y `anchor-spl`) | **No compila** junto a Anchor 1.2: `expected solana_pubkey::Pubkey, found a different solana_pubkey::Pubkey` (dos versiones de los tipos de Solana en el árbol) |
| Switchboard | `switchboard-on-demand 0.13.0` (`default-features = false`, `solana-v3`, `no-entrypoint`) | `anchor-lang >= 0.31` opcional; `solana-program` 3.x con la feature `solana-v3` | **Compila** junto a `anchor-lang 1.2.0` sin forks |

Conclusiones parciales:
- Según el criterio de descarte ("compatible con Anchor 1.x sin forks"), **ORAO queda descartado como dependencia de crate**. Solo sería viable construyendo a mano la CPI (instrucciones y cuentas codificadas manualmente), lo que añade superficie de error. Se reconsidera si publica una versión para Anchor 1.x.
- **Switchboard On-Demand pasa la fase 1.** Aún no se ha verificado lo siguiente:
  - que compile para SBF dentro del programa;
  - el coste en compute units;
  - su flujo commit/reveal y cómo se vincula a la ronda;
  - su modelo de confianza (oráculos en TEE).

### Fase 2 — Medición en devnet: Switchboard On-Demand (2026-09-28)

**Configuración:**
- Cliente desechable fuera del repo, con `@switchboard-xyz/on-demand 3.10.6`, `@coral-xyz/anchor 0.31.1` y Node 24.
- RPC pública de devnet con compromiso `confirmed`.
- Programa `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` y cola por defecto `EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7`.
- Firmante: el keypair de desarrollo de WSL `3R48JPhp8zkRokLdGJx8rFDT53CiKz92BYJErkipzpqV`, fondeado por el usuario desde su wallet de desarrollo `DUfBEagYErLiFnBk16QjR94pJJ3zPe1eQnTRHtfZQwZ4`.

**Procedimiento de cada ronda:**
1. transacción `randomness_commit`;
2. obtención del payload del gateway y transacción `randomness_reveal`;
3. lectura de la cuenta.

Se hicieron **100 rondas secuenciales** con 2 s de pausa entre ellas, porque la RPC pública devuelve HTTP 429.

| Métrica | Resultado |
| --- | --- |
| Rondas correctas | **100 / 100** (tasa de fallo 0 %; ninguna necesitó reintentar el reveal) |
| Latencia commit → reveal (slots) | mín. 15 · **p50 18** · p90 21 · **p95 28** · p99 29 · **máx. 30** |
| Latencia de reloj (cliente) | p50 5.7 s · p95 8.1 s |
| Coste por ronda | **10 000 lamports**: dos comisiones base de 5 000. No se cobró tarifa de oráculo |
| Coste único | Cuenta de randomness: 3 088 640 lamports de rent, más la lookup table. Total del spike: 0.007 SOL para 100 rondas |
| `seed_slot` | Siempre `slot_del_commit − 1` |
| `reveal_slot` | Siempre el slot de la transacción de reveal |

La latencia medida incluye las esperas de confirmación del propio cliente. Es una cota superior de lo que verá el *crank*. El valor propuesto de `entropy_timeout_slots = 150` deja un margen de 5x sobre el máximo observado.

Solo se midió una franja horaria; el método preveía dos. La cola de devnet puede comportarse distinto que la de mainnet.

**Hallazgos de integración** (se leyó el IDL on-chain, el crate `switchboard-on-demand 0.13.0` y se hizo una prueba con un tercero):
1. **`randomness_reveal` exige la firma de la `authority`** de la cuenta de randomness, además del `payer`. `randomness_commit` también la exige.
2. **Cualquiera puede obtener el payload del reveal del gateway.** Un cliente sin fondos y que no era la authority lo recibió: 105 bytes con el valor y la firma del oráculo. Aun así, no puede enviarlo on-chain sin la firma de la authority.
3. **Consecuencia de seguridad:** si la authority fuera el operador, este conocería `e` y, por tanto, el crash point H(s‖e). Podría entonces decidir no ejecutar `start_round` y dejar que la ronda acabe en `void` con reembolso. Eso es justo la opción gratuita que ADR 0002 quiere impedir. **Mitigación:** la authority debe ser una **PDA del programa**, y `start_round` debe hacer la CPI de `randomness_reveal` firmando con ella, sin permisos. Así cualquier jugador o vigilante puede iniciar la ronda con el payload público.
4. El crate trae una CPI para `randomness_commit` con `invoke_signed` (`RandomnessCommitAccounts::invoke`), pero **ninguna para `randomness_reveal`**. Habrá que construirla a mano a partir del IDL (12 cuentas; argumentos con firma, recovery id y valor). Es el principal riesgo de la integración y requiere pruebas específicas.
5. `RandomnessAccountData::parse` comprueba el discriminador pero **no el owner**. El programa debe verificar que el owner es el PID de Switchboard fijado para el cluster.
6. `get_value(clock.slot)` solo devuelve el valor **en el mismo slot del reveal**. Por eso la CPI de reveal y la lectura van en la misma instrucción `start_round`.
7. **Modelo de confianza:**
   - según la documentación de Switchboard, el valor lo genera un oráculo dentro de un TEE;
   - on-chain se verifica la firma secp256k1 del signer activo del oráculo (campos `oracle` y `activeSecp256K1Signer` de la cuenta);
   - **no es una prueba VRF verificable matemáticamente por terceros**, así que se confía en la integridad del TEE y en que el oráculo no colabore con el operador;
   - la documentación pública no detalla la atestación ni las penalizaciones.

## Recomendación

1. **Proveedor: Switchboard On-Demand.** ORAO queda descartado por incompatibilidad con Anchor 1.x. Switchboard cumple los criterios de descarte: vinculación mediante `seed_slot` y la cuenta fijada en la ronda, 0 % de fallos y compatibilidad sin forks.
2. **Diseño obligatorio:**
   - la cuenta de randomness de la casa tiene como authority una PDA del programa;
   - `close_betting` hace la CPI de `randomness_commit`, comprueba que `seed_slot = slot − 1` y guarda la cuenta y el `seed_slot` en `Round`;
   - `start_round`, sin permisos, recibe el payload del gateway, hace la CPI de `randomness_reveal`, comprueba el owner, la cuenta, el `seed_slot` y que `slot ≤ entropy_deadline_slot`, y lee `get_value(slot)`.
3. **Riesgo residual declarado:** se confía en el TEE y el oráculo de Switchboard, pero no en el operador.
4. Antes de mainnet: repetir la medición en otra franja horaria y en mainnet, medir las compute units de las dos CPIs dentro del programa, y hacer pruebas adversariales de la CPI de reveal construida a mano.
