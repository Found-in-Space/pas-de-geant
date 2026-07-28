# Little Planet

A room-scale WebXR relief Earth inspired by *Le Petit Prince*. Mean sea
level stays at the physical-floor apex beneath the headset while walking or
controller travel rolls the planet through that contact point.

## Run locally

From the repository root:

```sh
npm run dev:little-prince -- --port 4197
```

Open `http://127.0.0.1:4197`. The desktop fallback uses WASD to travel,
Z/X to change planet scale, C/V to change the radial multiplier, O to reveal
the seabed, and Backspace to reset.

WebXR requires a secure context. For a USB-connected Quest 2, an Android
reverse tunnel lets Oculus Browser treat the app as device-local:

```sh
adb reverse tcp:4197 tcp:4197
```

Then open `http://localhost:4197` on the headset. Any shared or deployed
build should be served over HTTPS.

## Quest controls

- Left stick: head-relative travel
- Left trigger: faster travel
- Right stick horizontal: whole-planet scale
- Right stick vertical: radial multiplier
- A: toggle sea surface / bathymetry
- Hold B: reset to 40° N, 4° W and the 10 m Iberia scale
- Right-stick press: toggle the wrist HUD

The camera and XR reference space are never moved to simulate travel. The
planet root is rolled and translated so the selected mean-sea-level contact
point remains beneath the headset.

Planet scale uniformly converts geographic kilometres into room metres.
The separate radial multiplier applies after that conversion to terrain,
aircraft altitude, bathymetry, and the 100 km atmosphere. The mean-sea-level
WGS84 ellipsoid remains the floor contact even when radial features are
exaggerated.

## Terrain and imagery

The checked-in `public/relief/gebco-2026-r16.bin` is a 4096×2048,
metre-quantized derivative of the GEBCO 2026 grid. To regenerate it from an
official stride-21 NetCDF subset:

```sh
npm run prepare:relief --workspace @found-in-space/little-prince
```

NASA GIBS supplies up to 32 nearby 512 px Blue Marble WMS images. The
checked-in 2048×1024 Blue Marble image remains usable when offline. Source,
license, datum, DOI, and checksum details live beside the relief asset and
in `public/THIRD_PARTY_LICENSES.txt`.

## Live aircraft proof of concept

The aircraft layer queries the public Airplanes.live point API for traffic
within 250 NM of the current underfoot coordinates. It polls every 30 seconds
only during an active immersive VR session, then dead-reckons positions
between reports from groundspeed, track, and track rate. Aircraft altitude
uses the same radial exaggeration as the terrain. Hiding the layer,
backgrounding the page, or leaving VR stops requests immediately.

Live aircraft are an optional feature, off by default on each page load.
Enable the checkbox before entering VR to use them. The setting remains in
effect for repeated VR sessions until the page is reloaded.

This refresh rate is intended only for short proof-of-concept sessions. The
published free allowance is not sufficient for an unattended or production
deployment; agree suitable commercial access before using the layer that
way.
