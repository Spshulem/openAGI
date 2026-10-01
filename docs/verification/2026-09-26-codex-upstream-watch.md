# OpenAGI Codex: vigilancia pública de la dependencia upstream

Fecha: 2026-09-26. Estado de OpenAGI: BLOCK / NOT QUALIFIED. Esta vigilancia no cualifica autenticación, esfuerzo efectivo, aislamiento de herramientas, entrega de texto ni activación.

Estado operativo posterior: temporizador **deshabilitado e inactivo** (`systemctl --user disable --now openagi-codex-upstream-watch.timer`; lectura posterior `UnitFileState=disabled`, `ActiveState=inactive`, sin próxima activación). La búsqueda solicitada es técnica y activa; este mecanismo de observación pasiva no la sustituye. El resto del documento conserva las pruebas históricas de cuando estuvo instalado y activo; ni esas pruebas ni el temporizador acreditan el requisito del proveedor.

## Fuentes y criterio

El vigilante consulta únicamente la documentación pública de la respuesta de OpenAI, el esquema oficial de `rawResponseCompleted` de Codex y la última etiqueta de release de Codex.[1][2][3]
En la primera lectura, la etiqueta era `rust-v0.157.1` y el esquema incluía ID de respuesta/hilo/turno y uso, pero no modelo ni esfuerzo efectivos.[2][3]
Una alteración de bytes o de etiqueta es una señal para investigar, nunca un veredicto favorable. La ausencia de cambios en estas tres fuentes tampoco prueba que no exista una nueva solución publicada en otro lugar.

## Instalación local, acotada

- Script canónico: `/home/crismote/.local/libexec/openagi_codex_upstream_watch.py`; pruebas: `test_openagi_codex_upstream_watch.py` en el mismo directorio. Sin paquetes nuevos: Python estándar.
- Estado: `/home/crismote/.local/state/openagi-codex-upstream-watch/state.json` (directorio 0700, fichero 0600). Guarda solo una etiqueta y dos digests públicos. Al detectar cambios, `pending.json` registra los nombres de las fuentes alteradas y la última instantánea pública; permanece hasta revisión explícita aunque `notify-send` termine con éxito, pues eso no demuestra que alguien leyera el aviso. Consulte la alerta pendiente tras iniciar sesión y elimínela solo después de revisar el cambio. El vigilante no consulta la configuración del proveedor, la cuenta, el perfil de Codex ni archivos de credenciales; no lanza inferencias.
- Unidades de usuario: `~/.config/systemd/user/openagi-codex-upstream-watch.{service,timer}`. La programación instalada era diaria a las 09:30 con dispersión máxima de 20 minutos; está deshabilitada. Si se habilitara, `Persistent=true` permitiría una comprobación pendiente al reactivarse el gestor de usuario, pero sin *linger* no prometería ejecución mientras el usuario estuviera desconectado.
- El proceso tiene límites de tiempo y tamaño por descarga, rechaza redirecciones, no usa proxies de entorno y restringe las escrituras al estado local. Su espacio de nombres oculta el resto del hogar y expone únicamente el script y el directorio de estado. `network-online.target` no existe en este gestor de usuario y fue eliminado como falsa garantía: la descarga real o su fallo determina el resultado. La primera ejecución establece la línea base; solo cambios posteriores intentan una notificación de escritorio. Si falla una descarga o la notificación, conserva la línea base para volver a intentarlo. Consulte `systemctl --user status openagi-codex-upstream-watch.timer` y `journalctl --user -u openagi-codex-upstream-watch.service` para diagnósticos.

Verificación histórica: 9/9 pruebas unitarias; ejecución directa inicial `baseline` y repetición `unchanged`. `systemd-analyze --user verify` pasó; el servicio real devolvió `unchanged` con resultado `success` tras endurecer el sandbox. Una prueba transitoria equivalente confirmó que el script y el estado son accesibles mientras otro archivo inocuo del hogar queda oculto. Antes de deshabilitarlo, el temporizador figuraba `enabled` y `active`; esta condición ya no es vigente. `openagi.service` seguía activo en aquella comprobación. No se modificó el servicio OpenAGI ni se hizo login, inferencia o publicación externa.

El cron de Hermes no se usó: necesita el gateway para disparar tareas,[4] y este gateway está detenido porque su dependencia `hermes-dual-boot-sync.service` falló; el árbol portable local además ha cambiado respecto de la última generación aplicada. Forzar una restauración o saltarse esa dependencia podría sobrescribir estado local. No se hizo ninguna de esas cosas. Este temporizador independiente no resuelve ni oculta el bloqueo de sincronización.

Ante una alerta: revisar semántica oficial del esfuerzo *efectivo* por respuesta, transporte de la declaración en Codex oficial y cierre de entrega; si existe una vía nueva, diseñarla y probarla en un candidato aislado con TDD, revisión adversarial y canarios reales. No iniciar sesión ni cambiar el proveedor por el mero hecho de recibir la alerta. La petición upstream redactada permanece en `workspace/consensus/2026-09-26-openagi-served-model-consensus/upstream-request-draft.md` y no se ha publicado.

## Sources

[1] https://developers.openai.com/api/reference/resources/responses/methods/retrieve.md — OpenAI response reference
[2] https://raw.githubusercontent.com/openai/codex/main/codex-rs/app-server-protocol/schema/json/v2/RawResponseCompletedNotification.json — Codex app-server schema
[3] https://api.github.com/repos/openai/codex/releases/latest — Codex latest release API
[4] https://hermes-agent.nousresearch.com/docs/user-guide/features/cron — Hermes scheduled tasks
