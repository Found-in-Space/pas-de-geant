interface EmulatorPose {
  readonly pitchDegrees?: number;
  readonly yawDegrees?: number;
  readonly rollDegrees?: number;
  readonly position?: { readonly x: number; readonly y: number; readonly z: number };
}

export interface PasDeGeantXrEmulatorApi {
  snapshot(): {
    readonly deviceName: string;
    readonly runtimeVersion: string;
    readonly stereoEnabled: boolean;
    readonly sessionActive: boolean;
    readonly visibilityState: string;
    readonly position: { x: number; y: number; z: number };
    readonly orientation: { x: number; y: number; z: number; w: number };
    readonly canvasDimensions?: { width: number; height: number };
  };
  setHeadsetPose(pose: EmulatorPose): ReturnType<PasDeGeantXrEmulatorApi["snapshot"]>;
  endSession(): Promise<void>;
}

declare global {
  interface Window {
    pasDeGeantXrEmulator?: PasDeGeantXrEmulatorApi;
  }
}

export async function installRequestedXrEmulation(): Promise<void> {
  const parameters = new URLSearchParams(window.location.search);
  const requested = parameters.get("xrEmulation") === "quest3";
  const enabled = import.meta.env.DEV ||
    import.meta.env.VITE_ENABLE_XR_EMULATION === "1";
  if (requested && enabled) {
    const { XRDevice, eulerToQuat, metaQuest3 } = await import("iwer");
    const device = new XRDevice(metaQuest3, { stereoEnabled: true });
    device.installRuntime({ forceInstall: true });
    const snapshot = (): ReturnType<PasDeGeantXrEmulatorApi["snapshot"]> => ({
      deviceName: device.name,
      runtimeVersion: device.version,
      stereoEnabled: device.stereoEnabled,
      sessionActive: device.activeSession !== undefined,
      visibilityState: device.visibilityState,
      position: { x: device.position.x, y: device.position.y, z: device.position.z },
      orientation: {
        x: device.quaternion.x,
        y: device.quaternion.y,
        z: device.quaternion.z,
        w: device.quaternion.w,
      },
      canvasDimensions: device.canvasDimensions,
    });
    window.pasDeGeantXrEmulator = {
      snapshot,
      setHeadsetPose(pose) {
        if (pose.position) {
          device.position.set(pose.position.x, pose.position.y, pose.position.z);
        }
        const orientation = eulerToQuat({
          pitch: pose.pitchDegrees ?? 0,
          yaw: pose.yawDegrees ?? 0,
          roll: pose.rollDegrees ?? 0,
        });
        device.quaternion.set(
          orientation.x,
          orientation.y,
          orientation.z,
          orientation.w,
        );
        device.notifyStateChange();
        return snapshot();
      },
      async endSession() {
        await device.activeSession?.end();
      },
    };
  }
  if (requested && !enabled) {
    console.warn(
      "Quest 3 WebXR emulation is disabled in this build. Use the development server or build with VITE_ENABLE_XR_EMULATION=1.",
    );
  }
}
