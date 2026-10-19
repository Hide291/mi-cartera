# Kapital — decisiones técnicas y lecciones aprendidas

Registro de por qué la app está hecha como está, qué se descartó y qué problemas aparecieron durante su creación (octubre de 2026). Pensado para quien la mantenga en el futuro, humano o asistente.

> Este repositorio es público y solo contiene código. Ningún dato personal (posiciones, importes, claves, URL del backend) debe entrar aquí: viven en la hoja de Google privada del propietario y en su documentación privada.

---

## 1. Arquitectura

| Pieza | Elección | Motivo |
|---|---|---|
| Interfaz | PWA estática (HTML, CSS y JS sin dependencias ni build) en GitHub Pages | Instalable en Android con icono propio y a pantalla completa, gratis, sin servidor que mantener |
| Datos | Hoja de Google privada (pestañas `Config`, `Activos`, `Lotes`, `Efectivo`, `Precios`, `Registro`) | El propietario puede abrirla y corregirla a mano, tiene historial de versiones de Google y no depende de ningún servicio de pago |
| Backend | Google Apps Script ligado a la hoja, desplegado como aplicación web | Descarga precios desde los servidores de Google (sin problemas de CORS en el navegador), guarda historial aunque nadie abra la app y sirve una API JSON |
| Motor de cálculo | `core.js`, funciones puras compartidas por el navegador y Node | Se puede probar en Node con datos reales sin interfaz |

**Descartado: artefacto de Claude con base de datos.** No es una app instalable de verdad (es una página dentro de claude.ai y exige sesión iniciada), no puede leer de forma fiable fuentes externas de precios desde el navegador, no guarda historial si no se abre y los datos quedarían atados a claude.ai.

**Descartado: servir la app desde el propio Apps Script.** Funciona, pero se abre como página de Chrome con la barra del navegador y sin icono propio; GitHub Pages da una PWA real.

**Descartado: app nativa (Capacitor/TWA).** La pantalla de Chrome que aparece al abrir es el bloqueo por huella de Chrome, que el propietario quiere mantener; una app nativa no aporta nada que compense compilarla y firmarla.

**Descartado: notificaciones (ntfy, Telegram, web push).** Los avisos útiles (precios que no se actualizan, cobro de intereses, revisión del reparto) los cubren tareas programadas de Claude que revisan la API y avisan al móvil solo si hay algo que hacer.

## 2. Backend (Apps Script)

- **API**: `GET ?action=data&key=…` devuelve todo (config, activos, lotes, efectivo, precios, cotizaciones en vivo). `POST` con `upsert`, `delete`, `setConfig` y `refresh`. La clave se compara en el servidor; `apiKey` no se puede cambiar por la API.
- **POST con `Content-Type: text/plain`**: Apps Script no responde a las peticiones previas CORS (preflight). Enviar el JSON como texto plano evita el preflight y funciona desde el navegador.
- **Redirecciones**: la URL `/exec` responde con una redirección a `googleusercontent.com`. Con curl hay que usar `-L`. A veces el primer intento devuelve una página HTML "Page Not Found": se reintenta. Un `upsert` con `id` existente es idempotente; uno **sin** `id` crearía duplicados, así que hay que comprobar con un GET antes de reintentar.
- **Escrituras con `LockService`** para que dos escrituras simultáneas no se pisen. `sanitize_` limita cada fila a las columnas conocidas de su tabla.
- **Activador cada 6 horas** (`setup()` lo crea y borra los anteriores) que ejecuta `actualizar()`.
- **Cambios en `Code.gs`**: hay que pegarlo en el editor de Apps Script y crear una **versión nueva de la misma implementación** (Implementar → Gestionar implementaciones → Editar → Nueva versión). Crear una implementación nueva cambiaría la URL y rompería el móvil y las tareas.

## 3. Fuentes de precios

| Dato | Fuente | Notas |
|---|---|---|
| Valor liquidativo de los fondos iShares | Excel oficial de BlackRock (`…/fund/1515395013987.ajax?fileType=xls…&dataType=fund`), pestaña de histórico | Es la cifra oficial, la misma que usa el bróker. Se publica con **un día hábil de retraso**: la app muestra siempre la fecha del VL |
| Acciones, índices y EUR/USD | Yahoo Finance (`query1.finance.yahoo.com/v8/finance/chart`) con `User-Agent` de navegador | Devuelve 429 (demasiadas peticiones) con facilidad, sobre todo desde servidores compartidos. Respaldo: Stooq (CSV diario) para los símbolos que lo tienen |
| Índices MSCI | Vía sus ETF (IWDA para MSCI World, EMIM para MSCI EM IMI) | MSCI no ofrece cotización gratuita; para una variación diaria orientativa el ETF basta |
| Cotización en vivo | `CacheService` de Apps Script | Evita llamar a Yahoo en cada apertura de la app |

- El VL se **redondea a 3 decimales**, como hace el bróker, para que valor y resultado cuadren al céntimo. El bróker podría truncar en lugar de redondear: la diferencia máxima observada es de unos 0,3 €.
- Los activos en USD se pasan a EUR con el EUR/USD del mismo día.

## 4. Modelo de datos y reglas de cálculo

- **Fechas** como texto `YYYY-MM-DD` y comparadas como texto: no hay zonas horarias de por medio.
- **Lotes FIFO**: cada compra es un lote con `fecha_fiscal`, `desde`, `hasta` (último día que se tuvo; vacío si sigue), `participaciones`, `coste` (fiscal) y `aporta` (dinero propio nuevo).
  - **Coste fiscal** y **dinero aportado** son campos distintos a propósito. En un **traspaso entre fondos** (neutro fiscalmente en España) los lotes de destino heredan fecha y coste fiscal del origen y tienen `aporta = 0`, así que no se cuenta dinero nuevo dos veces. En un **bono** del bróker, el lote tiene coste fiscal pero `aporta = 0`.
  - La rentabilidad mostrada por fondo es la **fiscal** (como la del bróker), no la de mercado desde el traspaso.
- **Ventas** (desde v26): se cierran los lotes con `hasta` = día anterior a la venta y se registra un movimiento de efectivo `tipo = venta` con el importe **neto** cobrado. El motor resta las ventas de lo aportado, así el resultado realizado queda en la ganancia y patrimonio, gráfico, rentabilidad y XIRR siguen siendo coherentes. **Lección**: la primera vez se cerraron lotes sin ese ajuste y la ganancia salía falseada en el importe vendido; solo se detectó simulando los datos antes de escribirlos.
- **Intereses de la cuenta remunerada**: saldo al final de cada día × tipo / 365, con tramo por encima de un umbral y retención del 19 %, mostrado en neto. Si un mes no se registra el cobro real, la app lo estima el día 1. El cobro real (de la captura del banco) sustituye a la estimación.
- **Reequilibrio sin vender**: el aviso calcula cuánto aportar al fondo que va por detrás para volver al objetivo (`Config.targetWorld`). La **calculadora de aportación** (v28) reparte un importe A así: World recibe `round(objetivo × (W + E + A) − W)`, acotado entre 0 y A, y el otro fondo el resto. Si A no basta, todo va al infraponderado y se indica cuánto faltaría.
- **Resumen de aportaciones** (v29): agrupa por el mes de `desde` el `aporta` de los lotes, separando fondos y acciones, y resta las ventas. Su total coincide con el recuadro «Invertido».
- **XIRR** solo con 12 meses o más de historial; antes se muestra la rentabilidad total, porque una TIR anualizada sobre semanas es engañosa.
- **Historial diario** reconstruido desde la primera compra con los lotes activos cada día y los precios guardados. Si no hay precio de un día, el lote se valora al coste para no inventar ganancias.
- **Aviso de datos viejos** en la portada si los precios no se descargan en 30 h o si el último VL tiene más de 6 días: detecta que el activador ha dejado de funcionar.
- **Limitación conocida**: la fila «Acciones vendidas» y el resumen de aportaciones suponen que toda venta es de acciones. Si algún día se reembolsa un fondo, hay que adaptar `stocksRealized` y `contributions` en `core.js`.

## 5. PWA y despliegue

- **Versión**: cada cambio sube `?v=N` en `index.html` y `mc-vN` en `sw.js`. El service worker instala la versión nueva, borra cachés viejas y la app se recarga sola una vez al detectar el cambio de controlador.
- **Estrategia de caché**: red primero con `cache: 'no-cache'` para los archivos propios (evita mezclar versiones por la caché HTTP de GitHub Pages, que es de 10 min) y copia local solo si no hay conexión. Las fuentes de Google se cachean. Las peticiones al backend **no** pasan por el service worker.
- **Configuración del móvil** con un enlace privado `…/#url=<aplicación web>&key=<clave>`: se guarda en `localStorage` y se borra de la barra de direcciones. La clave nunca está en el repositorio.
- **Icono**: fondo completo (maskable). Algunos Android ponen una placa blanca detrás de los iconos con transparencia.
- **GitHub Pages** despliega desde `main` (build "legacy"), normalmente en 1-2 minutos. El 19/10/2026 hubo una incidencia de GitHub y los despliegues estuvieron en cola cerca de una hora: se comprueba con `gh api repos/<owner>/mi-cartera/actions/runs` y en githubstatus.com antes de pensar que el código falla.
- `.gitignore` excluye `*.json` (salvo el manifest) y `private/`, para que nunca se suban datos de prueba reales.

## 6. Diseño

- Tema oscuro, tipografía Manrope y acento `#2BD4A4`. Semicírculo de reparto con marca del objetivo, inspirado en apps de seguimiento de carteras.
- Cada cifra real lleva su fecha («VL 16/10»); lo que no tiene fecha es un cálculo. Así se distingue a simple vista un dato de una estimación.
- Las cifras de cabecera se pueden tocar para ver su desglose («Último día», «Ganancia total», «Invertido») en lugar de llenar la portada de tarjetas fijas.
- Si no hay acciones, la app oculta todo lo relativo a ellas.
- El propietario prefiere una app sencilla. Se descartaron: copia de seguridad automática, indicador de fondo de emergencia, tarjeta de próximos eventos, proyección a largo plazo y objetivo de patrimonio.

## 7. Cómo se prueba

- **Motor**: Node con `core.js` y los datos reales leídos de la API (fuera del repositorio). Se comparan las cifras con los documentos del bróker y del banco.
- **Backend**: un simulador privado de los servicios de Apps Script (hojas, UrlFetch, Cache, Lock) ejecuta `Code.gs` en Node.
- **Interfaz**: Chromium + Playwright sirviendo la carpeta en local e interceptando la URL del backend para devolver datos simulados. Se recorren todas las pestañas y fichas, a 390 y 320 px de ancho, comprobando que no haya errores de consola ni desbordamiento horizontal. Después se prueba la app publicada contra el backend real.
- **Regla**: antes de escribir datos que cambian la lógica (por ejemplo, la primera venta), simular el estado final y comprobar las cifras.

## 8. Operativa con Claude

- El propietario manda capturas (aportación, traspaso, cobro de intereses, compra o venta) y Claude las registra por la API y comprueba que cuadran con el bróker y el banco. El procedimiento detallado vive en la documentación privada del proyecto.
- Tareas programadas de Claude: revisión semanal de solo lectura (precios al día, coherencia de lotes y saldos), recordatorio mensual del cobro de intereses y revisión semestral del objetivo de reparto según el peso de mercado. Si un cambio de datos afecta a lo que comprueban, se actualiza su prompt.
- Para publicar cambios de código, el repositorio debe estar autorizado en la sesión de Claude (push mediante el proxy de git de la sesión).

## 9. Historial de versiones relevante

| Versión | Cambio |
|---|---|
| v22 | Primera versión probada contra el backend real; aviso de datos viejos |
| v23 | Ganancia del periodo «Máx» igual a la ganancia total |
| v24 | Desglose del «Último día» |
| v25 | Desglose de la «Ganancia total» |
| v26 | Ventas como operación soportada (efectivo `venta`); secciones de acciones ocultas si no hay ninguna |
| v27 | «Invertido» indica «neto de ventas» |
| v28 | Calculadora de aportación |
| v29 | Resumen de aportaciones por mes y año |
