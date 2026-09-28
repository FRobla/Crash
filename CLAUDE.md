# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# [TEST] — Guía del proyecto

## Stack y comandos

- Next.js 16 (App Router, Turbopack), React 19, TypeScript `strict`, Tailwind CSS v4, ESLint 9 (`eslint-config-next`), Vitest + Testing Library (jsdom).
- Next.js 16 tiene cambios incompatibles con versiones anteriores: antes de escribir código de Next, consulta la guía relevante en `node_modules/next/dist/docs/`.
- Gestor de paquetes: **pnpm** (versión fijada en `packageManager`). No uses npm ni yarn ni generes otros lockfiles. `pnpm-workspace.yaml` (`allowBuilds`) controla qué dependencias pueden ejecutar scripts de instalación; revisa cada paquete antes de permitirlo.
- Red objetivo: **Solana devnet**. El cluster es la constante `SOLANA_CLUSTER` en `src/chain-adapters/solana/config.ts`, no una variable de entorno; pasar a mainnet exige un cambio de código deliberado con revisión legal, de riesgo y de seguridad. La UI comprueba el genesis hash del RPC y marca `wrong network` si no es devnet.
- Configuración pública: `.env.example` (copiar a `.env.local`). Las variables `NEXT_PUBLIC_*` se incrustan en el bundle del navegador: nunca pongas secretos en ellas.

| Tarea | Comando |
| --- | --- |
| Servidor de desarrollo | `pnpm dev` |
| Build de producción / servir | `pnpm build` / `pnpm start` |
| Lint | `pnpm lint` |
| Tipos (genera tipos de rutas y ejecuta `tsc`) | `pnpm typecheck` |
| Pruebas (una pasada / modo watch) | `pnpm test` / `pnpm test:watch` |
| Un archivo o una prueba concreta | `pnpm vitest run src/games/crash/ui/BetPanel.test.tsx -t "disables placing"` |
| Auditoría de dependencias | `pnpm audit` |

Las pruebas viven junto al código (`*.test.ts[x]` bajo `src/`). Vitest no soporta Server Components `async`; esos se cubrirán con pruebas E2E cuando existan.

## Estructura actual

```
src/
  app/                  # Rutas y composición únicamente (sin reglas de negocio)
    (dashboard)/        # Shell del dashboard: crash, history, fairness, bank
  platform/             # Capacidades compartidas entre juegos
    shell/              # Chrome del dashboard (sidebar, top bar, barra de estado, paneles)
    wallets/            # Puerto agnóstico de cadena: WalletSession
    product.ts          # Nombre provisional del producto
  games/crash/ui/       # Presentación de Crash (sin motor ni reglas todavía)
  chain-adapters/solana/  # Config devnet, salud del RPC, wallet adapter, activos
```

Límites de dependencias:
- `games/*` y `platform/*` no importan de `chain-adapters/*`. La composición ocurre en `src/app` (p. ej., `app/(dashboard)/layout.tsx` inyecta los componentes de Solana en los slots del shell).
- `chain-adapters/*` puede depender de puertos y UI de `platform/*`, nunca al revés.
- El dominio de Crash (motor, reglas, randomness, settlement) se añadirá en `src/games/crash/` y `src/platform/*` cuando exista su especificación; no crees carpetas vacías por adelantado.

## Producto

[TEST] es una plataforma de juegos de casino on-chain. Crash es el primer juego y el primer caso de uso de un protocolo pensado para incorporar más juegos, activos y blockchains sin reconstruir el núcleo del producto.

El MVP contempla Solana, apuestas en SOL y USDC, un house bank, rondas Crash provably fair, cash-out manual y automático, y una aplicación web en tiempo real. Los eventos económicos importantes deben poder verificarse en la blockchain. Se pueden usar servicios off-chain para indexación, caché, WebSockets, estadísticas y otras funciones de experiencia de usuario, pero no deben convertirse silenciosamente en la autoridad sobre el dinero o el resultado de una ronda.

## Visión de arquitectura

- Mantén el motor y las reglas de juego independientes de cualquier blockchain, wallet, token o proveedor de randomness concreto.
- Aísla las integraciones de red y activos mediante interfaces y adaptadores. Como mínimo, separa las responsabilidades de activos, wallets, transacciones, randomness y settlement.
- Trata Solana y SOL/USDC como los adaptadores iniciales, no como supuestos globales del dominio. Añadir otra red, activo o juego debería extender módulos existentes, no exigir una reescritura del núcleo.
- Comparte, cuando corresponda, la infraestructura de usuarios, wallets, balances, economía, randomness, verificación provably fair y house bank entre juegos.
- Mantén diferenciados el estado autoritativo on-chain y las proyecciones off-chain. Las proyecciones deben poder reconstruirse desde eventos autoritativos y su retraso o indisponibilidad no debe producir saldos ficticios ni liquidaciones contradictorias.
- Evita acoplar las reglas del juego a una interfaz web o a un proveedor externo. Define contratos explícitos entre el dominio, los adaptadores y las superficies de API/cliente.

No presupongas un lenguaje, framework, proveedor, protocolo de bridge, custodia o algoritmo de randomness que todavía no esté elegido en el repositorio. Antes de introducir uno, comprueba las decisiones existentes y explica brevemente las consecuencias relevantes.

### Estructura del código

- Organiza el repositorio con screaming architecture: los directorios de primer nivel deben comunicar las capacidades y límites principales del producto, no solo tecnologías como `controllers`, `models` o `utils`.
- Agrupa el código por dominio/capacidad, por ejemplo `games/crash`, `platform/wallets`, `platform/house-bank`, `platform/randomness` y `chain-adapters/solana`. Ajusta los nombres al stack y a las convenciones ya presentes.
- Dentro de cada capacidad, coloca dominio, casos de uso, puertos/adaptadores y pruebas cerca de su responsabilidad. Mantén los detalles de infraestructura en los límites y evita dependencias desde el dominio hacia frameworks o proveedores.
- Trata el ejemplo como guía de límites, no como obligación de crear directorios vacíos ni de fragmentar prematuramente un MVP. Cada módulo debe tener una responsabilidad clara y contratos explícitos.
- Evita carpetas globales de utilidades que mezclen reglas de negocio no relacionadas. Si una abstracción es compartida, ubícala en el módulo dueño de su contrato o en una capacidad de plataforma bien definida.

## Reglas de Crash

- Una ronda permite apuestas antes y durante la ventana admitida por las reglas; especifica claramente cuándo se aceptan y cuándo dejan de aceptarse.
- El multiplicador empieza en 1.00x y aumenta de manera determinista según una regla de tiempo y precisión definida.
- El jugador puede solicitar cash-out manual o configurar de antemano un auto cash-out. El importe liquidado se calcula con reglas explícitas de redondeo, límites y unidades.
- Si el cash-out válido se procesa antes del punto de crash, la ganancia depende de la apuesta y del multiplicador reconocido. Si el crash ocurre primero, la apuesta se pierde.
- Define una única regla verificable para ordenar cash-outs, auto cash-outs, cierres de apuestas y crash ante eventos concurrentes o retrasos de red. No dependas del orden de llegada observado por un único servidor.
- Especifica y prueba los límites de apuesta, multiplicador, exposición, redondeo, precisión y recuperación ante fallos antes de habilitar fondos reales.

El estado visible en tiempo real puede ser una proyección de eventos, pero la regla que decide el resultado económico debe ser determinista, auditable y coherente con la autoridad de settlement.

## Provably fair y randomness

- El resultado de cada ronda debe poder verificarse de forma independiente por usuarios y no debe poder alterarse retrospectivamente por el operador.
- Documenta el ciclo de vida completo del resultado: generación, compromiso previo, revelación o prueba, derivación del crash point y verificación independiente.
- El compromiso debe publicarse antes de que el operador conozca o pueda elegir el resultado de la ronda; la prueba posterior debe vincular inequívocamente ese compromiso con el resultado liquidado.
- Analiza explícitamente predicción, manipulación, sesgo de selección, repetición, colusión, no revelación y fallos del proveedor de randomness. No presentes un esquema como provably fair sin especificar sus supuestos y límites.
- Mantén separada la interfaz de randomness de su implementación. Un futuro cambio de red o proveedor no debe modificar las reglas del juego ni invalidar verificadores históricos.
- Conserva los datos públicos necesarios para que un verificador reproduzca el resultado de una ronda y comunica de forma visible cualquier ronda que no pueda verificarse.

No fijes un algoritmo criptográfico ni una fuente de randomness por conveniencia. Antes de implementarlos con dinero real, evalúa sus propiedades, disponibilidad, latencia, costes, modelo de confianza y compatibilidad con la verificación on-chain.

## House bank y riesgo

- El house bank es responsable de honrar las obligaciones de pago. Trata sus fondos, reservas y pasivos como recursos protegidos, con límites de exposición explícitos.
- El house edge inicial objetivo es cercano al 3%, pero es un objetivo que debe validarse matemáticamente, no una garantía implícita. Comprueba la distribución del crash point, el retorno esperado, los límites de apuesta y multiplicador, y la exposición agregada antes de aprobarla.
- Rechaza apuestas o cash-outs que excedan límites de fondos disponibles o de riesgo; los controles deben ser deterministas y aplicarse en el punto autoritativo, no solo en la interfaz.
- Define cómo se manejan fondos reservados, liquidaciones pendientes, operaciones duplicadas, reintentos y fallos parciales para evitar doble pago o gasto de fondos comprometidos.
- Mantén trazabilidad auditable entre depósitos, apuestas, cash-outs, resultados, pagos, comisiones y cambios de balance. No uses números de punto flotante para representar dinero.
- Los cambios a probabilidades, pagos, límites, reservas o comisiones requieren pruebas matemáticas y pruebas automatizadas de invariantes.

## Seguridad y manejo de fondos

- Considera cada flujo que toca fondos como código crítico. Aplica validación de entradas, autorización, límites, protección contra repetición y manejo idempotente donde corresponda.
- No confíes en valores calculados por el cliente para balances, multiplicadores, resultados, límites o pagos.
- Minimiza privilegios y superficie de custodia; nunca registres claves privadas, secretos, semillas no reveladas ni credenciales.
- Diseña para fallos de RPC, desconexiones, reintentos, reorganizaciones o retrasos de confirmación, límites de tasa y eventos duplicados. Expón el estado de confirmación de forma clara al usuario.
- Conserva registros suficientes para auditoría y respuesta a incidentes, sin filtrar secretos ni datos personales innecesarios.
- No afirmes que el sistema es seguro, justo, descentralizado o auditado sin evidencia verificable. Señala los supuestos de confianza y los riesgos residuales.
- Antes de operar con fondos reales, identifica los requisitos legales, regulatorios, de privacidad y de protección al consumidor aplicables a los mercados objetivo. No asumas que el despliegue on-chain los resuelve.

## Web app y experiencia en tiempo real

- La web debe permitir observar rondas, apostar, realizar cash-out, consultar resultados y verificar la aleatoriedad de cada partida.
- Presenta de manera inequívoca el estado de conexión, la ronda activa, los límites, el estado de las transacciones y si una acción fue aceptada, confirmada o rechazada.
- La animación y los WebSockets son presentación: nunca deben decidir el resultado, aceptar una acción fuera de las reglas ni contradecir la liquidación autoritativa.
- Gestiona reconexiones y eventos fuera de orden sin mostrar saldos o resultados como definitivos antes de tener evidencia suficiente.
- Mantén la verificación provably fair accesible y vinculada a los datos de la ronda que verifica.
- Usa una dirección visual oscura, sobria y funcional, inspirada en terminales y herramientas operativas; prioriza legibilidad, jerarquía de información, estados claros y contraste accesible sobre ornamentación.
- La interfaz debe ser atractiva en servicio de la comprensión y la operación, no a costa de ellas. No sacrifiques funcionalidad, accesibilidad, rendimiento ni transparencia económica por animaciones o decoración.

## Método de trabajo: SSD

Usa desarrollo guiado por especificaciones (SSD, Spec-Driven Development) combinando **spec-first** y **spec-anchored** según el riesgo y el contexto:

- **Spec-first:** para capacidades nuevas, cambios de arquitectura y cambios de alto impacto en dinero, seguridad, economía, randomness o contratos externos. Antes de implementar, define el problema, alcance, comportamiento esperado, invariantes, errores relevantes y criterios de aceptación comprobables. Resuelve o registra las decisiones abiertas que impidan una implementación segura.
- **Spec-anchored:** para cambios acotados en una capacidad existente. Ancla el trabajo en la especificación, reglas de dominio, contratos, pruebas y comportamiento existente más cercanos; identifica qué requisito se modifica y conserva los demás. Si no existe una especificación suficiente, actualiza o crea la mínima necesaria antes de cambiar comportamiento crítico.
- En ambos modos, sigue el ciclo: entender el requisito y el contexto local, definir o localizar la especificación, implementar el cambio mínimo, ejecutar pruebas focalizadas, revisar seguridad y actualizar documentación afectada.
- Mantén las especificaciones alineadas con el comportamiento real. No conviertas la especificación en documentación ceremonial ni la uses para justificar cambios que no cumplen los criterios de aceptación.
- Para cambios económicos, de settlement, randomness o seguridad, expresa los criterios como invariantes verificables y cubre condiciones límite, fallos y concurrencia con pruebas.

## Revisión de seguridad obligatoria

Realiza una comprobación de seguridad en cada cambio, aunque parezca pequeño. Antes de darlo por terminado, considera si afecta directa o indirectamente a fondos, autorización, datos, secretos, dependencias, límites de confianza o disponibilidad.

- Revisa entradas no confiables, autorización, validación, operaciones repetibles, idempotencia, concurrencia y manejo de errores en la ruta modificada.
- Verifica que el cliente, caché, indexador, API y servicios externos no puedan alterar decisiones autoritativas ni producir pagos o balances inconsistentes.
- Comprueba que logs, respuestas, artefactos y pruebas no expongan claves, secretos, datos personales o semillas que deban permanecer ocultas.
- Para cambios de contratos on-chain, wallets, apuestas, cash-out, balances, randomness, settlement o house bank, amplía la revisión: prueba invariantes y fallos adversariales, inspecciona límites y riesgos de reentrada/replay cuando aplique, y ejecuta las herramientas de análisis disponibles para el stack.
- Ejecuta las comprobaciones de seguridad disponibles y pertinentes, incluidas las de dependencias cuando el cambio las afecte. Informa claramente de las comprobaciones no disponibles o no ejecutadas; nunca presentes una revisión no realizada como aprobada.

## Calidad y cambios

- Antes de editar, inspecciona las instrucciones del repositorio, el código y las pruebas cercanas. Sigue las convenciones existentes y mantén los cambios acotados.
- Usa inglés americano (`en-US`) en el código, identificadores, comentarios, docstrings y nombres de pruebas. El texto visible de la interfaz debe seguir los requisitos de localización del producto.
- No introduzcas arquitectura, dependencias o infraestructura que no ayuden a un requisito concreto. Si una decisión de producto o seguridad está sin definir, anota la pregunta y sus opciones en vez de inventar una política.
- Para cambios de reglas económicas, randomness, settlement, balances o adaptadores, añade pruebas que cubran invariantes, límites, errores y casos concurrentes relevantes.
- Usa aritmética entera o decimal de precisión fija para cantidades económicas, con unidades y reglas de redondeo explícitas.
- Valida los cambios con las pruebas o comprobaciones más específicas disponibles; informa de las comprobaciones que no se pudieron ejecutar.
- Actualiza documentación y verificadores cuando cambie un contrato observable, una regla económica o el formato de los datos provably fair.
- Actualiza el `changelog.md` de la raíz para cada cambio importante. Añade una entrada fechada, breve y orientada al impacto, que describa qué cambió y, cuando sea relevante, sus efectos en comportamiento, seguridad, economía o compatibilidad. No registres cada ajuste trivial ni reescribas entradas anteriores.
- Considera importante cualquier cambio que afecte a comportamiento observable, arquitectura, contratos, persistencia, APIs, reglas económicas, seguridad, despliegue o experiencia de usuario significativa. Si el archivo todavía no existe, créalo al registrar el primer cambio importante.

## Evolución prevista

Prioriza el MVP: Solana, SOL/USDC, Crash, house bank, provably fair, cash-out manual y automático, y web app. Diseña los límites de módulos para permitir después más tokens, juegos, redes, un SDK/API para integraciones externas e infraestructura de house bank multi-game/multi-chain. No implementes esas fases anticipadamente salvo que exista una necesidad concreta del MVP.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
