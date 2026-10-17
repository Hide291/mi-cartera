# Mi Cartera

App personal (PWA) para seguir una cartera de fondos indexados, acciones y ahorro remunerado.

- **App**: HTML/CSS/JS sin dependencias, alojada en GitHub Pages. Instalable en Android ("Añadir a pantalla de inicio").
- **Datos**: viven en una hoja de Google privada del propietario. Este repositorio **no contiene ningún dato personal**.
- **Backend**: `backend/Code.gs` (Google Apps Script). Descarga el valor liquidativo oficial de BlackRock y cotizaciones de Yahoo Finance, y sirve una API protegida con clave.
- **Cálculos**: `core.js` (FIFO fiscal, intereses diarios de la cuenta remunerada con retención, historial, XIRR, reequilibrio).

La conexión se configura una sola vez en el móvil con un enlace privado del tipo `…/#url=<aplicación web>&key=<clave>`; la clave se guarda solo en el dispositivo.
