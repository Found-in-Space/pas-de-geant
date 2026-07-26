# Data and third-party notices

## Eclipse validation references

Shadowline performs its own calculations from provider ephemerides. A compact
set of test expectations is derived from NASA GSFC eclipse predictions
published by Fred Espenak:

- WGS 84 path table for the total solar eclipse of 12 August 2026  
  `https://eclipse.gsfc.nasa.gov/SEpath/SEpath2001/SE2026Aug12Tpath.html`
- WGS 84 path table and Besselian elements for the total solar eclipse of
  30 June 1973:
  `https://eclipse.gsfc.nasa.gov/SEpath/SEpath1951/SE1973Jun30Tpath.html`
  `https://eclipse.gsfc.nasa.gov/SEbeselm/SEbeselm1951/SE1973Jun30Tbeselm.html`

The source pages grant permission to reproduce the data when accompanied by
this acknowledgment:

> Eclipse Predictions by Fred Espenak, NASA's GSFC

These reference values are used only to test planning-grade agreement with
published paths and contacts. No NASA GIS dataset or generated derivative is
distributed with Shadowline.

## Leaflet

The application bundles Leaflet 1.9.4 from the locked npm dependency. Leaflet
is distributed under the BSD 2-Clause licence. See
`https://github.com/Leaflet/Leaflet` for its licence and source code.

## MapLibre GL JS

The spherical application view bundles MapLibre GL JS 5.24.0 from the locked
npm dependency. MapLibre GL JS is distributed under the BSD 3-Clause licence:

Copyright (c) 2023, MapLibre contributors

The complete licence, including notices for incorporated Mapbox GL JS and other
components, is distributed in the npm package and at
`https://github.com/maplibre/maplibre-gl-js/blob/main/LICENSE.txt`.

## Earcut

The application bundles Earcut 3.2.3 for renderer-only polygon triangulation.
Earcut is distributed under the ISC License:

Copyright (c) 2026, Mapbox

The complete licence text is included in `THIRD_PARTY_LICENSES.txt` in the
production application.

## Astronomy Engine

The default ephemeris adapter uses Astronomy Engine 2.1.19. Astronomy Engine is
distributed under the MIT License:

Copyright (c) 2019-2023 Don Cross

The complete licence text is distributed in the npm package and at
`https://github.com/cosinekitty/astronomy/blob/master/LICENSE`.

Shadowline's geometry and GIS APIs are independent of Astronomy Engine. If
portions of its algorithms are adapted into a future native provider, the
original copyright and MIT notice will be preserved with the derived source.

## OpenStreetMap

The planning application requests standard raster map tiles from
`tile.openstreetmap.org` for the user's current viewport. Map data is
copyright OpenStreetMap contributors and is available under the Open Data
Commons Open Database License. The application displays the required
attribution on the map and does not prefetch or redistribute the tiles.

The standard tile service is subject to the OpenStreetMap Foundation's tile
usage policy:
`https://operations.osmfoundation.org/policies/tiles/`

## NASA GIBS and Blue Marble

The fixed equirectangular view requests the
`BlueMarble_ShadedRelief_Bathymetry` layer from NASA's Global Imagery Browse
Services cacheable geographic WMTS endpoint:
`https://gibs.earthdata.nasa.gov/wmts/epsg4326/best/BlueMarble_ShadedRelief_Bathymetry/`.

The application displays NASA GIBS attribution with the map. Imagery is loaded
only for the visible fixed whole-Earth viewport and is not redistributed by
this repository. GIBS documentation is available at
`https://earthdata.nasa.gov/eosdis/science-system-description/eosdis-components/gibs`.

We acknowledge the use of imagery provided by services from NASA's Global
Imagery Browse Services (GIBS), part of NASA's Earth Observing System Data and
Information System (EOSDIS).
