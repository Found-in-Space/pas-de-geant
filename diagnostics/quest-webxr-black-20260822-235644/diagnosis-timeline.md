# Quest 3 WebXR blanking diagnosis

Captured locally on 2026-08-22/23. The untouched preexisting ring buffer is
`preexisting-logcat.txt`; the clean reproduction is `reproduction-logcat.txt`.

## Versions

- Device: Meta Quest 3 (`eureka`), Android 14
- Horizon OS branch: `releases-oculus-14.0-v207`
- Build incremental: `52433670032200520` (built 2026-08-19)
- Meta Quest Browser: `150.0.0.39.30.1038228660` (`versionCode=570301102`)

## Earlier archived Codex report

The archived task `Update eclipse controls` contains the earlier raw incident
that was previously summarized as a Guardian/tracking failure. It includes an
explicit headset-IMU deadline overrun immediately before the blanking action:

- 00:40:28.276: `libsensortelemetry` reports `imu_headset_0 samples delayed:
  7479134ns capture to arrival (ERS limit: 3500000ns)`.
- 00:40:28.760: Guardian's `GUIDING_TOAST_COMBINED_LEFT_BOUNDS` notification is
  muted.
- 00:40:28.809: VR Shell launches
  `com.oculus.os.clearactivity/.ClearActivity`, taking focus from WebXR.

The literal `IoteLogging: IMU Update exceeded imu sampling period` wording was
not present in that archive. The archived `libsensortelemetry` message describes
the same error class: an IMU update/sample arrived after its allowed sampling or
delivery deadline.

An older archived capture from 2026-08-08 also contains the same device-level
fault family during an unrelated network investigation:

- 14:30:47: `VrHeadPoseOrchestrator` reports `Delayed IMU measurements
  detected` with a 7.423 ms capture-to-arrival delta, followed by
  `libsensortelemetry` reporting 7.423 ms against the 3.5 ms limit.
- The same capture contains repeated `syncboss_spi: bad magic from MCU` and a
  later 6.950 ms headset-IMU delay.

That older capture was not itself diagnosed as a blanking incident, so it is
evidence that the sensor fault recurs across dates, not evidence that every IMU
overrun causes a blank.

## Archived/preexisting incident

The preexisting ring buffer contains the same established blanking signature:

- 22:34:24.394: headset IMU samples arrived 5.181 ms after capture; ERS limit 3.5 ms.
- 22:34:24.399: Browser launches `WebVRActivity`.
- 22:34:24.555: world-tracking camera frame sets miss deadlines.
- 22:34:26.667: headset IMU samples arrive 6.962 ms late.
- 22:34:33.982: camera buffer state is invalid.
- 22:34:38.129: Guardian emits `GUIDING_TOAST_COMBINED_LEFT_BOUNDS`.
- 22:34:38.196: the OS launches `com.oculus.os.clearactivity/.ClearActivity`.
- 22:34:38.246-38.501: `WebVRActivity` loses focus and stops behind the system interstitial.
- 22:35:04.535: headset IMU samples arrive 7.282 ms late.
- 22:35:06.323: `syncboss_spi` reports `bad magic from MCU`.
- 22:35:06.366: headset IMU samples arrive 5.251 ms late.

## Clean reproduction

The clean capture was started only after preserving the original ring buffer and
clearing volatile logcat. The reproduced page was
`https://stars.dev.k-si.com/apps/examples/xr-free-roam/index.html` (`Found in
Space - VR Free Roam`). The first run was manually exited; the second run began
at 23:02:24.522, flashed black at 23:05:07.046 after 2m42.5s, and became
persistently black at 23:05:18.794 after 2m54.3s. The Meta overlay remained
responsive as reported; whether audio continued was not established.

- 22:59:09 onward, before WebXR: tracking repeatedly drops late color-camera frame sets.
- 23:00:25.342: sensor-controller SPI reports `bad magic from MCU`.
- 23:00:27.248: camera buffer state is invalid.
- 23:00:33.410: IMU delivery is 5.327 ms, above the 3.5 ms limit.
- 23:00:35.254: first clean `WebVRActivity` launch.
- 23:00:35.398-35.431: color and world-tracking frame-set deadline failures.
- 23:00:43.996 onward: recurring IMU delays, normally about 5-7.4 ms.
- 23:01:40: the first run was manually exited with the Home button; this is not classified as a blanking event.
- 23:02:24.522: second clean `WebVRActivity` launch.
- 23:04:11 and 23:04:32: invalid camera buffers and incomplete color frame sets.
- 23:04:34.116 and 23:04:42.139: IMU delivery delays of 6.521 and 6.754 ms.
- 23:04:51.274: Guardian reports `COMBINED_LEFT_BOUNDS`.
- 23:04:54.011-54.139: another invalid camera buffer, incomplete frame set, and 5.540 ms IMU delay.
- 23:05:01.990: IMU delivery delay of 6.991 ms.
- 23:05:06.993: Guardian explicitly sets `GUARDIAN_SYSTEM_V2_EXITED_BOUNDS` while reporting the boundary as valid.
- 23:05:07.005: Guardian reports `COMBINED_LEFT_BOUNDS` again.
- 23:05:07.046: the OS launches `ClearActivity`; this first transition is a short black flash.
- 23:05:18.712: Guardian reports `COMBINED_LEFT_BOUNDS` again.
- 23:05:18.794: the OS launches `ClearActivity` again.
- 23:05:18.840-19.040: `WebVRActivity` loses top-resumed state, pauses, becomes visible-only, then stops.
- 23:05:19.024: `ClearActivity` becomes the top-resumed, focused activity.
- 23:05:19.554: sensor-controller SPI reports `bad magic from MCU`.
- 23:05:21.793: IMU delivery delay of 6.977 ms.
- 23:05:41: live dumps show focused/resumed `ClearActivity`, hidden `WebVRActivity`, and a fully black framebuffer (`post-blank.png`).
- 23:05:47: clean capture ends, more than 28 seconds after the persistent black transition.

## Reboot A/B

- A full reboot was performed after saving the clean capture and bugreport.
- 23:07:37.538, during system startup and before Browser/WebXR: IMU delivery is 16.220 ms, still above the 3.5 ms limit.
- The same page re-entered WebXR at 23:11:56.009. The initially planned capture
  ended at 23:16:07 while WebXR was still visible, but the user kept the session
  open and reported the next persistent blank at 23:17:21, 5m25.8s after entry.
- During that retest the log recorded 17 headset-IMU deadline overruns (up to
  7.125 ms), 11 `syncboss_spi` MCU-corruption messages, 24 invalid tracking-camera
  buffers, and 10 incomplete frame sets.
- 23:15:28.628: Guardian briefly added `GUARDIAN_SYSTEM_V2_EXITED_BOUNDS` while
  the room-scale boundary remained `GUARDIAN_VALID`, but recovered to in-bounds
  22 ms later without launching `ClearActivity`.
- 23:16:53.041 and 23:16:56.351: IMU delivery overruns reach 7.189 and
  7.590 ms.
- 23:17:05.111 and 23:17:09.151: `syncboss_spi` reports `bad magic from MCU`.
- 23:17:12.923: another IMU overrun of 6.990 ms.
- 23:17:15.326-17.232: two more MCU `bad magic` errors surround another
  6.752 ms IMU overrun.
- 23:17:21.695: Guardian adds `GUARDIAN_SYSTEM_V2_EXITED_BOUNDS` even though
  the boundary is still `GUARDIAN_VALID`; it records in-bounds to out-of-bounds
  at 23:17:21.701 and recovers 27 ms later.
- 23:17:21.775: VR Shell nevertheless launches `ClearActivity`.
- 23:17:21.845: Browser's `WebVRActivity` pauses; it stops at 23:17:21.958.
- 23:18:25: live activity/window dumps show focused, resumed `ClearActivity`
  with `WebVRActivity` invisible beneath it. `post-reboot-blank.png` is fully
  black. Thermal status is 0 and Browser has 137 MiB total PSS, with no crash,
  ANR, or low-memory kill.
- Result: a full reboot did **not** prevent the failure. The same sensor faults,
  false boundary exit, and Guardian black interstitial all recurred. The active
  retest is in `post-reboot-retest-logcat.txt`; the preserved black-state ring
  buffer and aftermath are `post-reboot-blank-logcat.txt` and
  `post-reboot-blank-followup-logcat.txt`.

## Boundary-history reset A/B

- Using the current v207 Settings UI, the user cleared boundary history and
  created a new room-scale boundary. No Browser data or other setting was
  changed.
- A first continuous WebXR pass ran from 23:28:00.788 to 23:34:10.249
  (6m09.5s) and was manually exited without a Guardian blank.
- A second continuous pass began at 23:34:21.150. At the final read-only state
  check after 23:42:41 (at least 8m20s), `WebVRActivity` was still visible and
  top-resumed. The diagnostic logger was then intentionally stopped while the
  session remained active.
- During that second pass, the system still recorded 43 headset-IMU deadline
  overruns, 16 `syncboss_spi: bad magic from MCU` messages, 22 invalid tracking-
  camera-buffer errors, and 11 incomplete frame sets.
- Despite those continuing faults, the same interval contained zero
  `GUARDIAN_SYSTEM_V2_EXITED_BOUNDS`/left-bounds events, zero `ClearActivity`
  launches, and zero WebVR pauses or stops.
- Result: recreating the boundary prevented the reproduced blank for longer
  than both previous time-to-failure measurements (2m54s and 5m26s). This is a
  meaningful mitigation result, although a single non-failing 8m20s pass does
  not prove that the problem is permanently fixed. The sensor-pipeline errors
  were not fixed by the boundary reset. Full logs are in
  `boundary-reset-retest-logcat.txt`.

## Settings and reversible tests

- Cleared only volatile logcat after saving the untouched baseline; no user or
  application data was cleared.
- Performed one full headset restart; result documented above.
- Read-only inspection found no user-facing tracking-frequency value exposed in
  Android's global, secure, or system settings stores. The boot log nevertheless
  records `Updating utility frequency to 50Hz from flicker_sensor`, followed by
  both MR cameras switching to 50 Hz. This indicates automatic 50 Hz detection,
  not a forced-60 Hz mismatch. No tracking-frequency setting was changed.
- Guardian boundary history was cleared and a new room-scale boundary was
  created; the A/B result is documented above. No Browser flags, cookies, site
  data, tracking-frequency value, or undocumented system property was changed.
- Camera cleaning/lighting, native-app comparison, and the seated boundary-
  disabled test were not performed in this capture set.

## Interpretation

- Immediate cause of the black display: confirmed Guardian safety transition. The OS deliberately puts the black `ClearActivity` in front of WebXR after deciding the headset has exited its bounds.
- Underlying fault: the system tracking/sensor pipeline. IMU late delivery, camera-buffer invalidation, frame-set deadline misses, dropped late color frames, and intermittent sensor-controller SPI corruption co-occur and also appear outside WebXR.
- The literal `IoteLogging: IMU Update exceeded imu sampling period` string does not occur in these three local captures. The local equivalent is `libsensortelemetry: imu_headset_0 samples delayed ... (ERS limit: 3500000ns)`.
- No thermal throttling was present (`Thermal Status: 0`), Browser memory was moderate, and no Browser crash, ANR, or low-memory kill caused the blank.
- Browser/WebXR may increase tracking load or expose the failure, but the fault is not confined to Browser: camera drops occurred before WebXR and an IMU overrun recurred during boot after a full reboot.
- Recreating boundary history stopped the false-exit/black-cover sequence for
  at least 8m20s even while the sensor warnings continued. This separates the
  user-visible blanking mechanism from the persistent sensor warnings: stale or
  inconsistent boundary history was likely a contributing condition that made
  tracking glitches become false boundary exits.

## Classification and external comparison

- Best-fit immediate classification: **Guardian/boundary fault, confirmed**.
  Both the archived and clean incidents follow the same sequence: false
  out-of-bounds state, `ClearActivity`, then hidden/stopped `WebVRActivity`.
- Best-fit underlying classification: **system tracking/sensor-pipeline fault,
  high confidence; firmware/software versus hardware remains inconclusive**.
  The repeated IMU, camera, and sensor-controller failures survive a reboot and
  occur outside Browser, but native-app tracking loss has not yet been tested.
- Boundary-history contribution: **probable, medium confidence**. The fresh
  boundary eliminated Guardian exits over two longer passes but did not
  eliminate any of the underlying sensor-fault families. More use is needed to
  establish whether this is a lasting fix rather than a temporary remission.
- Meta's current public release-note index documents Browser 149.1 (2026-07-27)
  only as security/reliability/performance fixes plus WebGPU space-warp support;
  it does not yet document this headset's Browser 150 build or a matching fix:
  https://developers.meta.com/horizon/release-notes/
- A current independent report on Horizon OS v207 and Browser 149.1 records the
  exact `IoteLogging: IMU Update exceeded imu sampling period` warning during
  WebXR tracking/localization contention. Its symptom is a persistent frame-rate
  drop and it reproduces with Guardian disabled, so it corroborates the v207 IMU
  warning but is not the same Guardian blanking failure:
  https://communityforums.atmeta.com/discussions/Questions_Discussions/quest-pro-browser-webxr-session-frame-production-permanently-drops-13-after-20%E2%80%935/1380174
- An older Browser black-screen report was traced to `bounded-floor` reference
  space. That does not fit this capture: this page rendered for minutes and the
  OS then launched `ClearActivity` after an out-of-bounds decision:
  https://communityforums.atmeta.com/discussions/dev-quest/meta-quest-browser-shows-a-black-screen-for-some-webxr-apps-in-latest-patch/1224303/replies/1224854

## Recommended discriminator

Keep using the newly created boundary and note whether another blank occurs. If
it does, clean the tracking cameras and repeat under even lighting, then run the
same-duration test in a native immersive app; a native failure would materially
strengthen the hardware/system tracking diagnosis. A brief seated boundary-
disabled WebXR run can then prove whether suppressing Guardian prevents only the
black cover while the sensor faults continue. Re-enable the boundary
immediately afterward.
