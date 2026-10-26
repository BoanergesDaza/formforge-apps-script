# FIX — errores conocidos y cómo resolverlos

Guía de diagnóstico del formulario, el panel de administración y el backend de Apps Script. Para entender cómo encajan las piezas, lee antes el [README](README.md).

## Contenido

- [Cómo diagnosticar](#cómo-diagnosticar)
- [Backend y despliegue de Apps Script](#backend-y-despliegue-de-apps-script)
- [Formulario y subida de archivos](#formulario-y-subida-de-archivos)
- [Panel de administración](#panel-de-administración)
- [Hoja de Google Sheets](#hoja-de-google-sheets)
- [Drive y correos de aviso](#drive-y-correos-de-aviso)
- [Frontend y hosting (Vercel)](#frontend-y-hosting-vercel)
- [Git y terminal en Windows](#git-y-terminal-en-windows)
- [Lista de comprobación después de cualquier cambio](#lista-de-comprobación-después-de-cualquier-cambio)

---

## Cómo diagnosticar

Cuando algo falla, el mensaje que ve el usuario suele ser genérico. La causa real está en uno de estos cuatro sitios, en este orden:

1. **El mensaje en pantalla.** Muchos errores son específicos ("Tipo de archivo no permitido", "Contraseña incorrecta"). Búscalo en este documento con Ctrl+F.
2. **Apps Script > Ejecuciones** (icono de reloj, a la izquierda). Cada petición del formulario es una ejecución de `doPost`. Importante: **`doPost` aparece como "Completada" aunque haya fallado**, porque el servidor captura el error y se lo devuelve al navegador. Haz clic en la ejecución y busca en el registro una línea de nivel **Error**: ahí está la causa real.
3. **La consola del navegador** (F12 > Consola y Red). Muestra bloqueos de la política de contenido, errores de red y la respuesta exacta del servidor.
4. **Una petición directa con `curl`**, para saber si el problema es del backend o del sitio:

```bash
# El backend responde (debe devolver ok:true)
curl -sL "https://script.google.com/macros/s/TU_ID/exec"

# El backend entrega las preguntas del formulario
curl -sL -H "Content-Type: text/plain" -d '{"action":"getConfig"}' "https://script.google.com/macros/s/TU_ID/exec"
```

Interpretación rápida del primer comando:

| Respuesta | Significado |
|---|---|
| `{"ok":true,"data":{"service":"form-solicitudes"}}` | El backend está bien. El problema está en otro lado. |
| HTML de inicio de sesión de Google (`accounts.google.com`) | La implementación no es pública. Ver [el formulario no carga](#no-se-pudo-cargar-el-formulario-no-hay-conexión-con-el-servidor). |
| HTML con "No se encontró la función de la secuencia de comandos: doGet" | El código no está publicado. Ver [no se encontró la función](#no-se-encontró-la-función-de-la-secuencia-de-comandos-doget--dopost). |
| Error 404 de Google | La URL es incorrecta o la implementación fue archivada. |

---

## Backend y despliegue de Apps Script

### No se pudo cargar el formulario. No hay conexión con el servidor.

**Síntoma.** El formulario muestra ese mensaje al abrirse, aunque haya internet.

**Causas frecuentes**

- La implementación de Apps Script no es pública. Una petición recibe la página de inicio de sesión de Google, no JSON. Es la causa más común.
- `config.js` todavía tiene el texto `PEGAR_AQUI_LA_URL_DEL_WEB_APP` o una URL con un error de tipeo.
- Una extensión del navegador (bloqueador de anuncios, privacidad) bloquea `script.google.com`.
- En producción, la política de contenido (`vercel.json`) bloquea la conexión. Ver [la página se ve sin estilos](#la-página-se-ve-sin-estilos-sin-fotos-o-sin-datos-en-producción).

**Solución**

1. Prueba el `curl` de arriba.
2. Si devuelve la página de Google: en Apps Script, **Implementar > Gestionar implementaciones**, lápiz. Pon **Ejecutar como: Yo** y **Quién tiene acceso: Cualquier persona**. En Versión elige **Nueva versión** y pulsa **Implementar**. La URL no cambia.
3. Si la cuenta es de un dominio de Google Workspace y la opción "Cualquier persona" no aparece, el administrador del dominio la tiene bloqueada. Hay que habilitarla en la consola de administración, o usar una cuenta de Gmail personal.

### No se encontró la función de la secuencia de comandos: doGet / doPost

**Síntoma.** El `curl` o el navegador muestran esa frase en una página de Google.

**Causa.** La implementación no tiene el código de `Code.gs`: nunca se pegó, se guardó pero no se publicó una versión nueva, o la URL pertenece a otro proyecto.

**Solución**

1. Abre el proyecto, `Código.gs`, y comprueba que contiene `function doGet()`. Si no, pega `apps-script/Code.gs` completo y guarda.
2. **Implementar > Gestionar implementaciones**, lápiz, **Nueva versión**, **Implementar**.
3. Comprueba que la URL de esa implementación sea la de `config.js`.

> Guardar el código **no** lo publica. El Web App sirve la última *versión* implementada.

### ReferenceError: window is not defined (en un archivo `.gs`)

**Síntoma.** En Ejecuciones aparece `ReferenceError: window is not defined`, con un archivo como `app.js.gs`. Pueden fallar todas las peticiones.

**Causa.** Se pegó por error un archivo del frontend (`app.js`, `config.js`, `admin.js`) como archivo de Apps Script. Apps Script ejecuta el código de **todos** los archivos `.gs` al arrancar cada petición, y `window` no existe ahí.

**Solución.** Borra ese archivo del proyecto de Apps Script. Deben quedar solo `Código.gs` y `appsscript.json`. Crea una Nueva versión de la implementación.

### Los permisos especificados no son suficientes para llamar a Session.getEffectiveUser

**Síntoma.** `setup()` o el guardado del panel fallan con `Exception: Los permisos especificados no son suficientes para llamar a Session.getEffectiveUser. Permisos necesarios: https://www.googleapis.com/auth/userinfo.email`.

**Causa.** Al manifiesto le falta el permiso `userinfo.email`.

**Solución**

1. En **Configuración del proyecto**, activa "Mostrar el archivo de manifiesto appsscript.json".
2. En `oauthScopes` deben estar estos cinco permisos:
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/spreadsheets`
   - `https://www.googleapis.com/auth/script.external_request`
   - `https://www.googleapis.com/auth/script.send_mail`
   - `https://www.googleapis.com/auth/userinfo.email`
3. Guarda, ejecuta `setup` otra vez y acepta los permisos nuevos.
4. Crea una **Nueva versión** de la implementación.

### Pedí cambios en Code.gs y el sitio se comporta igual

**Causa.** Guardar no publica. O el navegador/servidor tiene la configuración anterior en caché.

**Solución**

1. **Implementar > Gestionar implementaciones > lápiz > Nueva versión > Implementar**.
2. La configuración de preguntas se guarda 10 minutos en la caché del servidor. Espera o guarda cualquier cambio en el panel, que la renueva.
3. En el navegador, recarga ignorando la caché: **Ctrl+Shift+R**.

### Falta la propiedad X. Ejecuta setup().

**Causa.** El script busca una propiedad (`SPREADSHEET_ID` o `ROOT_FOLDER_ID`) que no existe en **Propiedades del script**. Pasa en un proyecto nuevo donde no se ejecutó `setup()`, o si se borraron las propiedades.

**Solución.** Ejecuta `setup()`. Si quieres usar una hoja o carpeta existente, crea antes la propiedad con su ID.

### No existe la pestaña "Respuestas". Ejecuta setup().

**Causa.** `SPREADSHEET_ID` apunta a una hoja donde la pestaña no existe: tiene otro nombre, o es otra hoja (por ejemplo, una de prueba).

**Solución**

1. Comprueba que `SPREADSHEET_ID` sea el ID de la hoja correcta (la parte de la URL entre `/d/` y `/edit`).
2. Comprueba que la pestaña se llame **exactamente** como `SHEET_NAME` en `Code.gs`, o ajusta la constante.
3. Ejecuta `setup()` de nuevo: crea las pestañas que falten sin tocar los datos.

### No se puede abrir la hoja (error de acceso a un documento)

**Síntoma.** En el registro aparece un error al abrir el documento, o `No tienes permiso para acceder al documento`.

**Causa.** La cuenta que ejecuta el script no tiene acceso de **editor** a la hoja de `SPREADSHEET_ID`. Es típico al migrar a otra cuenta.

**Solución.** Desde la cuenta dueña de la hoja, compártela como editor con la cuenta del script. Después vuelve a ejecutar `setup()`.

### Error temporal del servidor. Intenta de nuevo.

**Síntoma.** El formulario falla al enviar con ese texto, a veces tras esperar un buen rato en 100 %.

**Causa.** Es el mensaje genérico cuando el servidor lanzó un error que no es de validación. **La causa real está en el registro de la ejecución** (ver [Cómo diagnosticar](#cómo-diagnosticar)). Las más comunes:

| Línea del registro | Qué hacer |
|---|---|
| `Falta la propiedad …` | Ver [Falta la propiedad](#falta-la-propiedad-x-ejecuta-setup) |
| `No existe la pestaña …` | Ver [No existe la pestaña](#no-existe-la-pestaña-respuestas-activa-ejecuta-setup) |
| Error de acceso al documento | Ver [No se puede abrir la hoja](#no-se-puede-abrir-la-hoja-error-de-acceso-a-un-documento) |
| `La fila N de "…" quedó vacía tras escribirla` | Ver [La fila quedó vacía](#la-fila-n-quedó-vacía-tras-escribirla) |
| `No se pudo obtener el bloqueo` | Otra ejecución estaba escribiendo. Reintenta en un minuto. |
| `Drive respondió …` | Error de Drive: cuota, almacenamiento lleno o archivo borrado. Ver [Drive](#drive-y-correos-de-aviso) |
| `Service invoked too many times` o cuota de correo | Se alcanzó una cuota diaria de Google. Espera 24 horas o reduce el volumen. |

### La fila N quedó vacía tras escribirla

**Causa.** La hoja descartó la escritura sin dar error: una protección de rango, una validación estricta o un filtro de la hoja impiden escribir en esa fila.

**Solución.** Revisa **Datos > Hojas y rangos protegidos** y las validaciones de datos de la pestaña de respuestas. El script debe poder editar toda la fila.

### El formulario dice que se envió, pero no aparece la fila

**Causas posibles**

1. **`SPREADSHEET_ID` apunta a otra hoja.** El correo de aviso trae el botón "Abrir hoja de respuestas" que apunta a la hoja que usa el script. Ábrelo y busca ahí.
2. **Duplicado detectado.** Si el navegador reintentó con el mismo identificador de solicitud, el servidor responde "recibido" sin escribir otra vez. Recarga la página para empezar una solicitud nueva.
3. **La fila se borró o se movió.** Revisa el historial de versiones de la hoja (**Archivo > Historial de versiones**).
4. **Se escribió en otra pestaña** por un nombre de pestaña parecido. Comprueba `SHEET_NAME`.

### Exception: No puedes configurar el formato de número de las celdas de una columna con texto

**Causa.** La pestaña es una *tabla* de Google Sheets cuyas columnas tienen tipo propio, y el código intentó dar un formato de número a la fila nueva. Sheets lo rechaza, a veces con retraso.

**Solución.** El código actual **no** aplica formatos por fila (solo escribe valores), así que si el error reaparece hay código modificado que llama a `setNumberFormat` o `setNumberFormats` en la fila nueva. Quita esa llamada.

### Lock timeout / el panel o el formulario se cuelgan

**Causa.** Varias ejecuciones pelean por el candado del script (se usa al crear carpetas, agregar filas y guardar la configuración). Una ejecución atascada retiene el candado hasta 30 segundos.

**Solución.** Espera un minuto y reintenta. Si se repite, revisa Ejecuciones para ver cuál se quedó colgada y qué la bloquea.

---

## Formulario y subida de archivos

### Mensajes de validación del formulario

| Mensaje | Causa y solución |
|---|---|
| `Falta: …` / `Este campo es obligatorio.` | Campo obligatorio vacío. |
| `Selecciona una opción.` | Una pregunta de opción única o lista no tiene selección. |
| `Especifica la opción "Otro".` | Se marcó "Otro" sin escribir cuál. |
| `Escribe 8 dígitos que empiecen con 6 o 7, o un número internacional con + y el código de país.` | Celular inválido. Ejemplos válidos: `71234567`, `+59171234567`. |
| `Usa solo letras, sin números.` | Ciudad o país con dígitos o símbolos. |
| `La fecha no puede ser anterior a hoy.` | La fecha límite está en el pasado. |
| `La extensión estimada debe ser un número o un rango de páginas, p. ej. 50-140.` | Escribe `80` o `50-140`. |
| `Opción no válida en …` | La página está usando preguntas viejas. Recarga con **Ctrl+Shift+R**. |
| `Solicitud rechazada.` | Se llenó el campo trampa "Sitio web". Puede pasar si el autocompletado del navegador lo rellena: desactívalo o recarga. |

### Tipo de archivo no permitido / Tamaño de archivo no permitido / Demasiados archivos

**Causa.** El archivo no cumple las reglas de `FILE_RULES`: extensión permitida, tamaño total máximo por campo y cantidad máxima de archivos.

**Solución.** Convierte o comprime el archivo. Para cambiar los límites, edita `FILE_RULES` en `Code.gs` y publica una nueva versión.

### El archivo "x" no es un PDF válido. Revisa que no esté dañado.

**Causa.** El servidor compara los primeros bytes del archivo con la firma real del formato declarado por la extensión. Falla si el archivo está dañado, está vacío, o es de otro tipo con la extensión cambiada (por ejemplo, un ejecutable renombrado a `.pdf`, o una imagen renombrada a `.docx`).

**Solución.** Abre el archivo en su programa original y vuelve a guardarlo o exportarlo. Si el archivo es legítimo y sigue rechazándose, su formato puede no estar entre los verificados (PDF, JPG, PNG, WebP, HEIC, DOC, DOCX).

### La subida de "x" se interrumpió. Vuelve a intentar.

**Causa.** La sesión de subida de Drive caducó o se perdió (404 o 410), por ejemplo tras dejar el formulario abierto muchas horas.

**Solución.** Pulsa **Reintentar**. Si no funciona, recarga la página y vuelve a enviar.

### Un archivo no terminó de subirse / La sesión expiró / La subida expiró

**Síntoma.** Cualquiera de estos mensajes pide "Vuelve a enviar la solicitud".

**Causa.** El servidor guarda cada solicitud y cada subida en una caché de 6 horas. Si el usuario tardó más, o si la caché se vació, el servidor ya no reconoce la solicitud. El formulario reinicia el estado solo.

**Solución.** Volver a enviar. Los archivos ya subidos de esa sesión se vuelven a subir.

### Los datos del carnet cambiaron. Vuelve a enviar la solicitud.

**Causa.** Tras un envío fallido, la persona cambió el carnet o la extensión. La carpeta ya estaba creada para los datos anteriores.

**Solución.** Volver a enviar. Se crea la carpeta correcta.

### Drive no aceptó el fragmento / Drive respondió 4xx o 5xx

**Causa.** Error pasajero de Drive, o la cuenta dueña del script se quedó sin espacio.

**Solución.** El formulario reintenta hasta 4 veces con espera creciente. Si persiste, revisa el almacenamiento de la cuenta dueña del script (drive.google.com/settings/storage) y vuelve a intentar.

### La barra se queda mucho tiempo al 100 %

**Causa.** El formulario ya subió todo y está esperando que el servidor registre la solicitud. Si otra petición retiene el candado, espera hasta 30 segundos y reintenta.

**Solución.** Espera. Si pasan varios minutos y termina con error, mira el registro de ejecución ([Cómo diagnosticar](#cómo-diagnosticar)) y no vuelvas a pulsar el botón repetidamente.

### La subida de archivos grandes es lenta

**Causa.** Cada fragmento de 8 MB pasa por Apps Script, que tiene una latencia fija de varios segundos por petición. Hasta 3 archivos suben a la vez.

**Solución.** Es el comportamiento esperado: un archivo de 1 GB tarda varios minutos. La conexión del usuario también cuenta.

---

## Panel de administración

### Contraseña incorrecta / Demasiados intentos fallidos. Espera 15 minutos.

**Causa.** Contraseña equivocada, o 20 intentos fallidos seguidos, que bloquean el login 15 minutos.

**Solución.** Si la recuerdas, espera 15 minutos. Si no, ver [Olvidé la contraseña](#olvidé-la-contraseña).

### Olvidé la contraseña

**Solución.** En el editor de Apps Script, elige la función `resetAdminPassword` en el desplegable de funciones y pulsa **Ejecutar**. El **Registro de ejecución** muestra la línea `Nueva contraseña del panel admin: …`. Entra con ella y cámbiala desde el panel. Si el registro no se ve, ábrelo en **Ejecuciones**.

> La contraseña inicial solo se imprime la primera vez que corre `setup()`. Si `setup()` se ejecuta de nuevo, no la vuelve a mostrar.

### Falta la contraseña del panel. Ejecuta setup().

**Causa.** El proyecto no tiene contraseña guardada porque `setup()` nunca corrió.

**Solución.** Ejecuta `setup()`, o `resetAdminPassword` si solo falta la contraseña.

### La sesión expiró. Vuelve a ingresar.

**Causa.** Las sesiones del panel duran 2 horas.

**Solución.** Vuelve a entrar. Los cambios sin guardar se pierden: guarda antes de dejar el panel abierto mucho tiempo.

### No se guardó: …

| Mensaje | Causa |
|---|---|
| `Hay una pregunta sin texto.` | Una pregunta quedó sin enunciado. Escríbelo o elimínala. |
| `La pregunta "…" necesita al menos una opción.` | Una lista, opción única o casillas sin opciones. |
| `Agrega al menos un correo de aviso.` | La lista de correos está vacía. |
| `Correo no válido: …` | Un correo mal escrito. |
| `Máximo 10 correos de aviso.` / `Máximo 60 preguntas.` | Límites del sistema (`MAX_QUESTIONS` en `Code.gs`). |
| `Identificador de pregunta no válido.` / `Tipo de pregunta no válido.` | La configuración enviada no es la que generó el panel. Recarga la página y repite. |

### Las preguntas que edité no cambian en el formulario

**Causa.** La configuración se guarda 10 minutos en la caché del servidor y el navegador puede tener la página anterior.

**Solución.** Guarda de nuevo en el panel (renueva la caché) y recarga el formulario con **Ctrl+Shift+R**.

### Una pregunta de fábrica volvió a su texto o tipo original

**Causa.** Al actualizar el código se subió `CONFIG_VERSION`, y la migración (`migrateConfig_`) reescribe el texto, el tipo y las opciones de las preguntas listadas en `MIGRATED_IDS`. Conserva si están activas u obligatorias, su sección y su orden.

**Solución.** Vuelve a editarla en el panel. Para evitarlo en el futuro, no subas `CONFIG_VERSION` salvo que cambies esas preguntas en `Code.gs` a propósito.

### No puedo cambiar el tipo de una pregunta

**Causa.** Las preguntas de fábrica solo cambian de tipo dentro de su familia: respuesta corta ↔ párrafo, y lista ↔ opción única ↔ casillas. Nombre, carnet, extensión y foto del carnet están bloqueados porque arman la carpeta. Celular, ciudad, páginas, fecha y archivos tienen un tipo fijo porque validan un dato concreto.

**Solución.** Si necesitas otro comportamiento, crea una pregunta nueva (admite respuesta corta, párrafo, número, fecha, lista, opción única y casillas) y desactiva la de fábrica.

### Fotos del sitio

| Síntoma | Causa y solución |
|---|---|
| `Usa una imagen JPG, PNG o WebP.` | El archivo no es de esos formatos. Convierte la imagen. |
| `La imagen debe pesar menos de 6 MB.` | El navegador la reduce a 1600 px, pero el original debe poder leerse. Prueba con otra foto o redúcela antes. |
| `No se pudo abrir esa imagen.` | El navegador no entiende el formato (por ejemplo, HEIC). Conviértela a JPG. |
| `No se pudo subir: …` (error del servidor) | Suele ser que el administrador del dominio de Google bloquea compartir por enlace, que el Drive está lleno o que la sesión expiró. Mira el registro de ejecución. |
| `Esa foto no se puede cambiar.` | El identificador no está en `SITE_SLOTS` de `Code.gs`. Agrégalo y publica una nueva versión. |
| La foto cambió en el panel pero no en el sitio | El navegador guarda la última lista de fotos. Recarga con **Ctrl+Shift+R**. Comprueba que `index.html` y `Code.gs` tengan el mismo identificador. |
| `No se pudo leer la lista de fotos de la página principal.` | `admin.html` no encuentra `index.html` en la misma carpeta del sitio. |
| La foto subida no se ve | La CSP debe permitir `https://lh3.googleusercontent.com` en `img-src` (`vercel.json`). |

---

## Hoja de Google Sheets

### Los valores aparecen en columnas equivocadas

**Causa.** El servidor escribe cada respuesta en la columna que indica su configuración. Si se **mueven o insertan columnas a mano** en la hoja, los valores nuevos seguirán entrando en la posición original.

**Solución.** No muevas ni insertes columnas de la pestaña de respuestas. Para ordenar la vista, usa filtros o vistas de filtro. Las columnas nuevas se agregan solas al final cuando se crea una pregunta desde el panel.

### Se perdió la lista desplegable de ESTADO

**Causa.** Se modificó la definición de la tabla de Sheets de forma parcial (por ejemplo, con la API) y se perdió la regla de validación de la columna.

**Solución.** Vuelve a seleccionar la columna `ESTADO` y aplica de nuevo la validación de datos (lista desplegable con los estados). No lo hagas con una petición parcial a la API de tablas: reemplaza todas las propiedades de columna.

### Un encabezado de la hoja cambió solo

**Causa.** Al guardar el panel, el servidor actualiza el encabezado de cada pregunta con su texto actual.

**Solución.** Es esperado: el encabezado sigue el texto de la pregunta. Si quieres otro encabezado, cambia el texto de la pregunta en el panel.

### Borré una pregunta y su columna sigue en la hoja

**Causa.** Por diseño: al eliminar una pregunta, su columna y sus respuestas se conservan para no perder datos.

**Solución.** Si quieres quitarla, bórrala tú de la hoja. No afecta al funcionamiento.

---

## Drive y correos de aviso

### Se creó una carpeta nueva en vez de reutilizar la de la persona

**Causa.** La clave `user:<CI>-<EXT>` de las propiedades del script se perdió (por ejemplo, tras migrar de cuenta) o la carpeta anterior está en la papelera.

**Solución.** Sin la propiedad, el script busca antes una carpeta cuyo nombre empiece con `CI-EXT-`. Si no la encuentra, crea una nueva. Para unir carpetas, muévelas a mano.

### Las carpetas se crean en el Drive equivocado

**Causa.** El script está desplegado con "Ejecutar como: Yo" desde otra cuenta, o se implementó desde la cuenta de quien programó el sistema en vez de la del cliente.

**Solución.** Los archivos ocupan el espacio de la cuenta dueña del script. Despliega el proyecto desde la cuenta correcta (ver [Migrar a otra cuenta](README.md#10-migrar-a-otra-cuenta-de-google)).

### No llegan los correos de aviso

**Causas**

- La lista de correos del panel está vacía o mal escrita.
- Se agotó la cuota diaria de correo de Apps Script. Los correos fallidos se omiten, pero **la solicitud igual queda registrada**.
- El correo llegó a spam.

**Solución.** Revisa la lista en el panel, mira la carpeta de spam y el registro de ejecución (busca `No se pudo enviar el aviso`). Si es la cuota, se restablece en 24 horas; mientras tanto las solicitudes siguen entrando a la hoja.

### Quien recibe el aviso no puede abrir la carpeta del usuario

**Causa.** El acceso de editor a la carpeta principal se da al guardar el panel con ese correo en la lista. Además, el correo debe corresponder a una cuenta de Google.

**Solución.** Quita y vuelve a agregar el correo en el panel, y guarda. Si el correo no es de Google, compártele la carpeta por enlace.

### Seguridad: me preocupa que alguien suba un archivo infectado

**Qué hace el sistema.** Valida la extensión, el tamaño y el primer fragmento del archivo (su firma real). Los archivos nunca se ejecutan ni se publican. Drive los analiza con su antivirus al descargarlos.

**Qué se recomienda a quien los abre.** Descargar y abrir los archivos con un antivirus actualizado, y desconfiar de documentos de Word que pidan "habilitar macros". Si no necesitas `.doc` (el formato antiguo, que admite macros), quítalo de `EXT_DOCS` en `Code.gs` y acepta solo `.docx`.

---

## Frontend y hosting (Vercel)

### La página se ve sin estilos, sin fotos o sin datos en producción

**Síntoma.** Funciona en local pero en producción faltan fuentes, fotos o las preguntas no cargan.

**Causa.** La política de contenido de `vercel.json` bloquea algo que el sitio intenta cargar. Por defecto solo permite: scripts propios, estilos propios y de Google Fonts, fuentes de `fonts.gstatic.com`, imágenes propias, `data:`, `blob:` y `lh3.googleusercontent.com`, y conexiones a `script.google.com` y `script.googleusercontent.com`.

**Solución**

1. Abre la consola del navegador (F12) y busca mensajes `Refused to load …` o `Content Security Policy`.
2. El mensaje indica la directiva y el dominio bloqueados. Agrega ese dominio a la directiva correspondiente de `vercel.json` (`img-src`, `connect-src`, `script-src`…).
3. Haz commit y push. Vercel vuelve a desplegar solo.

### Vercel pide iniciar sesión para ver el sitio

**Causa.** La protección de despliegues (Deployment Protection) está activa.

**Solución.** En el proyecto de Vercel: **Settings > Deployment Protection**, desactívala para producción.

### Vercel no ve mi repositorio privado

**Causa.** La aplicación de GitHub de Vercel no tiene permiso sobre ese repositorio.

**Solución.** En <https://vercel.com/new>, pulsa **Adjust GitHub App Permissions** y dale acceso a ese repositorio.

### Cambié algo y el sitio sigue igual

**Causas**

- Vercel todavía está desplegando (tarda 1 o 2 minutos tras el `push`).
- El navegador tiene la versión anterior en caché.
- Las fotos de `assets/` se guardan en caché 30 días (`Cache-Control` en `vercel.json`): si reemplazas una foto con el **mismo nombre**, el navegador puede seguir mostrando la anterior.

**Solución.** Espera el despliegue, recarga con **Ctrl+Shift+R** y, para fotos reemplazadas, usa un nombre de archivo nuevo.

### `/apps-script/Code.gs` o `/README.md` dan 404 en el sitio

**Causa.** Es intencional: `.vercelignore` excluye esos archivos del sitio público.

### El formulario dice "No se pudo cargar" y `config.js` todavía tiene el texto de ejemplo

**Causa.** `SCRIPT_URL` sigue con `PEGAR_AQUI_LA_URL_DEL_WEB_APP`.

**Solución.** Pon la URL `/exec` del Web App en `config.js`, haz commit y push.

---

## Git y terminal en Windows

| Problema | Solución |
|---|---|
| En PowerShell, `&&` da error (`The token '&&' is not a valid statement separator`) | En Windows PowerShell 5.1 no existe `&&`. Pon cada comando en su propia línea, o sepáralos con `;`. |
| `gh` no se reconoce justo después de instalarlo | Cierra la terminal y abre una nueva: la instalación actualiza el PATH. |
| `git push` rechazado (`non-fast-forward`) | Hay commits remotos que no tienes. Ejecuta `git pull --rebase` y luego `git push`. |
| Avisos `CRLF will be replaced by LF` | Son inofensivos: Git normaliza los saltos de línea de Windows. |
| Escribí `! comando` en PowerShell y falló | El prefijo `!` solo funciona dentro del chat de Claude Code. En PowerShell se escribe el comando sin `!`. |
| Subí fotos pesadas por error y el repositorio crece | Las fotos de `assets/` están pensadas para versionarse. Si agregas muchas, redúcelas antes. Quitarlas del historial exige reescribirlo. |

---

## Lista de comprobación después de cualquier cambio

Úsala tras publicar una versión nueva del backend o del sitio.

1. `curl -sL "<URL /exec>"` devuelve `{"ok":true,…}`.
2. `curl -sL -H "Content-Type: text/plain" -d '{"action":"getConfig"}' "<URL /exec>"` devuelve las preguntas esperadas.
3. La landing carga sin fotos rotas, y la consola (F12) no muestra errores de la política de contenido.
4. El formulario abre, muestra los tres pasos y las listas de sugerencias.
5. El panel `/admin.html` muestra el login, y entra con la contraseña.
6. Un envío de prueba con un carnet inventado crea la carpeta en Drive, la fila en la hoja y el correo de aviso.
7. Los datos de prueba se borran (carpeta y fila).
