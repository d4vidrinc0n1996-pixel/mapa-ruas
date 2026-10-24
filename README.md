# Mapa RUAS

App web progresiva (PWA) para ver las zonas permitidas y restringidas de vuelo para drones, con visor GPS en tiempo real. Una sola base de código funciona en Android, iPhone, Windows, macOS y Linux: se abre en el navegador y se puede instalar como app.

## Funciones

- **Zonas oficiales en vivo.** En Colombia se consultan directamente las capas del [Visor Geográfico UAS (RUAS) de la Aerocivil](https://aerocivil.maps.arcgis.com/apps/instant/media/index.html?appid=b4be4d501c8d4bcabd0c35297521c16e):
  - Zonas de no vuelo dron (ZNVD)
  - Aeropuertos: 6 km (prohibido) y de 6 a 9 km (máx. 61 m)
  - Helipuertos: 3 km
  - Áreas AIP
  - Aviación deportiva
  - Infraestructura aeronáutica
- **Visor GPS.** Muestra posición, precisión, altitud, velocidad y rumbo. Sigue tu ubicación y evalúa la zona en tiempo real. Mientras está activo mantiene la pantalla encendida.
- **Consulta de cualquier punto.** Toca el mapa, busca un lugar o escribe coordenadas (`6.1645, -75.348`).
- **Semáforo de estado.** Prohibido, requiere autorización, altura limitada, precaución (a menos de 500 m de una zona) o sin restricciones conocidas. Muestra el detalle y las observaciones oficiales de cada zona.
- **Zonas propias.** Importa un GeoJSON (ver `data/ejemplo-zonas.geojson`).
- **Uso sin conexión.** La app, los últimos datos descargados y las teselas visitadas quedan en caché.

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
js/zones.js             Almacén de zonas y evaluación de un punto
js/sources.js           Carga de capas (ArcGIS FeatureServer, GeoJSON)
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
   - `source`: `{ type: 'arcgis', url }` para servicios ArcGIS, o `{ type: 'geojson', url }` para un archivo GeoJSON (local en `data/<código>/` o remoto con CORS).
   - `category`: `prohibited`, `restricted`, `limited`, `caution` o `info`. También puede ser una función de las propiedades.
   - `name`, `subtitle`, `details`, `maxAltitudeM` y `radiusM` (para puntos), como valores o funciones.
3. Regístralo en `js/countries/index.js` y agrega el archivo a la lista `SHELL` de `sw.js`.

## Aviso

Herramienta informativa. Puede haber restricciones temporales (NOTAM, eventos) o cambios que no aparezcan aquí. No reemplaza la normativa vigente ni las autorizaciones de la autoridad aeronáutica: el piloto es responsable de cada vuelo.
