# Mi Ruta de Reparto

App web (PWA) para cargar direcciones de entrega y armar la ruta más corta
a pie/bici entre todas ellas. Se puede "instalar" en el celular Android
como si fuera una app normal.

## Cómo funciona
- **Buscar**: escribís una dirección y elegís de las sugerencias (usa el
  buscador gratuito de OpenStreetMap/Nominatim).
- **Pegar lista**: pegás varias direcciones, una por línea, y las carga
  todas (con una pequeña espera entre cada una para respetar el límite
  del servicio gratuito de geocoding).
- **Optimizar ruta**: reordena las paradas pendientes con el camino más
  corto en línea recta (vecino más cercano + mejora 2-opt), ideal para
  a pie o bici donde no importan sentidos de calles.
- El botón 📍 usa tu ubicación actual como punto de partida.
- Tocás el checkbox de cada parada a medida que entregás el paquete.
- Se puede reordenar a mano arrastrando desde el ☰.
- Todo se guarda en el celular (localStorage), así que si cerrás la app
  no perdés la lista.

## Importante sobre "offline"
La app (pantallas, lista, el orden ya calculado) funciona sin internet
una vez instalada. Lo que SÍ necesita conexión es:
- Buscar/agregar una dirección nueva (geocoding).
- Ver el mapa con las calles (las imágenes del mapa se descargan al vuelo).

O sea: conviene cargar y optimizar la ruta del día con datos/wifi antes
de salir a repartir, y después ya podés tildar entregas sin señal.

## Cómo instalarla en el celular de tu amigo
Para que Android permita "Agregar a pantalla de inicio" con ícono propio,
la app tiene que estar servida por HTTPS (no alcanza con abrir el archivo
localmente). La forma más simple y gratis es GitHub Pages:

1. Creá un repositorio nuevo en GitHub (puede ser privado o público).
2. Subí todo el contenido de esta carpeta (`reparto-app/`) a ese repo.
3. En el repo: Settings → Pages → Source: elegí la rama principal y
   carpeta `/ (root)`. Guardá.
4. GitHub te da una URL tipo `https://tu-usuario.github.io/tu-repo/`.
5. Abrí esa URL en el Chrome del celular de tu amigo → menú (⋮) →
   "Agregar a pantalla de inicio" (o va a aparecer un cartel automático
   de instalar).

Si querés, te ayudo a hacer el repo y subirlo por vos (tengo acceso a tu
terminal). También se puede probar localmente antes en tu netbook con:

```
cd ~/reparto-app
python3 -m http.server 8080
```

y abriendo `http://localhost:8080` en el navegador.

## Cosas que se pueden mejorar más adelante
- Guardar varias "rutas del día" distintas (ahora es una sola lista activa).
- Compartir la lista optimizada por WhatsApp.
- Notas por parada (piso, timbre, horario).
- Usar rutas reales por calle en el mapa (hoy dibuja línea recta entre
  paradas; el orden que calcula sigue siendo válido, solo el dibujo en
  el mapa es una aproximación).
