# Mapa RUAS

App web progresiva (PWA) para ver las zonas permitidas y restringidas de vuelo para drones, con visor GPS en tiempo real. Una sola base de código funciona en Android, iPhone, Windows, macOS y Linux: se abre en el navegador y se puede instalar como app.

## Funciones

- **Zonas oficiales en vivo, por país:**
  - **Colombia:**
    - Capas del [Visor Geográfico UAS (RUAS) de la Aerocivil](https://aerocivil.maps.arcgis.com/apps/instant/media/index.html?appid=b4be4d501c8d4bcabd0c35297521c16e):
      - Zonas de no vuelo dron (ZNVD)
      - Aeropuertos: 6 km (prohibido) y de 6 a 9 km (máx. 61 m)
      - Helipuertos: 3 km
      - Áreas AIP
      - Aviación deportiva
      - Infraestructura aeronáutica
    - **Áreas protegidas del RUNAP** (servidor de Parques Nacionales Naturales):
      - Parques y santuarios nacionales: requiere autorización de PNN.
      - Áreas regionales: precaución, consultar a la autoridad ambiental.
      - Se omiten las reservas privadas de la sociedad civil.
  - **España:** zonas geográficas UAS de ENAIRE en formato ED-269, el estándar europeo: aeronáuticas, urbanas e infraestructuras.
  - **Estados Unidos:** capas de la FAA:
    - Espacio controlado con techos LAANC
    - Espacio aéreo de uso especial
    - Defensa nacional
    - Seguridad nacional
    - Estadios
  - Las capas muy grandes (infraestructuras de España, rejilla LAANC) se cargan solo para la zona visible y para el punto consultado.
- **Visor GPS.** Muestra posición, precisión, altitud, altura aproximada sobre el terreno, velocidad y rumbo. Sigue tu ubicación y evalúa la zona en tiempo real. Mientras está activo mantiene la pantalla encendida. Si arrancas en otro país registrado, cambia de país solo.
- **Sitios de interés para volar (Colombia).** Cada marcador lleva un borde con el color de su estado de vuelo, calculado con las zonas cargadas. Al tocarlo se abre su ficha con la evaluación y las condiciones. Hay un filtro para ocultar los sitios donde no se puede volar.
  - **47 sitios destacados** (`data/co/sitios.geojson`): paisajes icónicos con descripción y consejo. Sus coordenadas están verificadas con Nominatim/OpenStreetMap y se pueden editar a mano.
  - **1.792 miradores y cascadas de OpenStreetMap** (`data/co/miradores-osm.geojson`), visibles al acercar el mapa. Se actualizan con `node tools/update-osm-sitios.mjs CO`.
- **Consulta de cualquier punto.** Toca el mapa, busca un lugar o escribe coordenadas (`6.1645, -75.348`).
- **Semáforo de estado.** Prohibido, requiere autorización, altura limitada, precaución, sin restricciones conocidas o **datos incompletos**. Nunca muestra luz verde si falta alguna capa. Muestra el detalle y las observaciones oficiales de cada zona.
- **Altura máxima real.** Con la elevación del terreno (Open-Meteo, modelo Copernicus de 90 m) convierte los techos absolutos en altura sobre el suelo. Por ejemplo, en el anillo de 6–9 km de un aeropuerto colombiano el límite es la elevación de referencia + 61 m.
- **Condiciones de vuelo:**
  - Viento a 10 m y a 120 m, ráfagas, lluvia, visibilidad, nubes y temperatura (Open-Meteo).
  - Salida y puesta del sol.
  - Índice geomagnético Kp (NOAA SWPC).
  - Un veredicto con umbrales orientativos (`LIMITS` en `js/conditions.js`).
- **Mapas base:**
  - Sin clave: OSM, claro, oscuro, calles, satélite, híbrido, topográfico y relieve.
  - Con clave propia: Mapbox, MapTiler y Google (Map Tiles API).
  - Las claves se guardan solo en el dispositivo (panel Capas → Claves de API) y no van al repositorio. Restríngelas a tu dominio en el panel de cada proveedor.
- **Zonas propias.** Importa un GeoJSON (ver `data/ejemplo-zonas.geojson`).
- **Uso sin conexión.** La app, los últimos datos descargados (zonas, clima) y las teselas gratuitas visitadas quedan en caché.

### Límites conocidos

- La FAA comparte una cuota de consultas por minuto entre todos sus usuarios. En horas de mucho uso responde «Too many requests»: la app reintenta con espera creciente, y mientras tanto el estado aparece como «Datos incompletos».
- Google exige mostrar su logotipo con sus mapas. Revisa sus condiciones antes de un uso comercial.
- Ninguna fuente incluye todos los NOTAM o restricciones temporales.

## Ejecutar en local

Requiere Node.js 18 o superior. No hay dependencias que instalar.

```bash
npm start
```

Abre http://localhost:5173. Para probar desde un teléfono en la misma red usa `HOST=0.0.0.0 npm start`. Ten en cuenta que el GPS del navegador sólo funciona con **HTTPS** (o en `localhost`).

## Publicar

Es un sitio estático: basta con subir la carpeta a cualquier hosting con HTTPS, como GitHub Pages, Netlify, Cloudflare Pages o Vercel. Desde el teléfono se abre la URL y se elige «Instalar app» (Android/escritorio) o «Compartir → Agregar a pantalla de inicio» (iPhone).

Si se publica una versión nueva, sube el número de versión de las cachés en `sw.js`.

## Estructura

```
index.html              Interfaz
css/app.css             Estilos (móvil primero, modo oscuro)
js/app.js               Mapa, paneles, búsqueda, GPS y estado
js/zones.js             Almacén de zonas, carga por teselas y evaluación de un punto
js/sources.js           Carga de capas (ArcGIS FeatureServer, GeoJSON) y formato ED-269
js/basemaps.js          Mapas base gratuitos y con clave
js/conditions.js        Clima, sol, elevación del terreno e índice Kp
js/pois.js              Sitios de interés coloreados según el estado de vuelo
data/co/                Sitios destacados y miradores/cascadas de OSM
tools/update-osm-sitios.mjs  Regenera los miradores y cascadas desde OpenStreetMap
js/render.js            Dibujo de zonas en Leaflet
js/gps.js               Seguimiento de posición
js/geo.js               Utilidades geométricas
js/countries/           Un módulo por país
sw.js                   Service worker (caché y modo sin conexión)
tools/make-icons.mjs    Genera los iconos PNG (npm run icons)
```

## Agregar un país

1. Crea `js/countries/<código>.js` copiando la forma de `co.js`. Debe definir: código, nombre, `center`, `zoom`, `bounds`, altura máxima, autoridad, reglas generales y la lista de `layers`.
2. En cada capa indica:
   - `source`: `{ type: 'arcgis', url }` para servicios ArcGIS, o `{ type: 'geojson', url }` para un archivo GeoJSON (local en `data/<código>/` o remoto con CORS). Si la capa es grande, añade `tiled: { tileDeg, minZoom }` para cargarla por zona visible.
   - `category`: `prohibited`, `restricted`, `limited`, `caution` o `info`. También puede ser una función de las propiedades.
   - `name`, `subtitle`, `details`, `maxAltitudeM`, `ceilingAmslM` y `radiusM` (para puntos), como valores o funciones.
   - Si el país publica en formato **ED-269** (estándar de la UE), basta con `...ED269` de `js/sources.js` (ver `es.js`).
3. Opcional: añade `pois` con archivos GeoJSON de sitios de interés (ver `co.js`). `node tools/update-osm-sitios.mjs <código>` genera los miradores y cascadas de OSM del país.
4. Regístralo en `js/countries/index.js` (con sus `bounds`) y agrega el archivo a la lista `SHELL` de `sw.js`.

## Aviso

Herramienta informativa. Puede haber restricciones temporales (NOTAM, eventos) o cambios que no aparezcan aquí. No reemplaza la normativa vigente ni las autorizaciones de la autoridad aeronáutica: el piloto es responsable de cada vuelo.
