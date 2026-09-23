import type { Landmark } from "@mediapipe/tasks-vision";

export type CameraViewMode = "front" | "oblique" | "side";
export type CalibrationConfidence = "low" | "medium" | "high";
export type CalibrationMetricKey = keyof CalibrationMetricValues;

export interface CalibrationMetricValues {
  headTilt: number;
  shoulderTilt: number;
  neckForward: number;
  spineTilt: number;
}

export interface CalibrationFrameSample extends CalibrationMetricValues {
  bodyYaw: number;
  yawAgreement: number | null;
  torsoRecline: number | null;
}

export interface CalibrationPoseSummary extends CalibrationMetricValues {
  metricMad: CalibrationMetricValues;
  bodyYaw: number;
  yawMad: number;
  yawAgreement: number | null;
  torsoRecline?: number | null;
  torsoReclineMad?: number | null;
  sampleCount: number;
}

export interface CameraCalibrationProfile {
  schemaVersion: 2 | 3 | 4;
  cameraFacing: CalibrationPoseSummary;
  working: CalibrationPoseSummary;
  reclined?: CalibrationPoseSummary | null;
  reminder: CalibrationPoseSummary | null;
  learnedMetrics: CalibrationMetricKey[];
  cameraYaw: number;
  cameraYawMagnitude: number;
  viewMode: CameraViewMode;
  confidence: CalibrationConfidence;
}

export interface BodyYawEstimate {
  angle: number;
  shoulderAngle: number;
  hipAngle: number | null;
  agreement: number | null;
}

export interface TorsoReclineEstimate {
  /** Positive means the shoulders move behind the hips; negative means forward lean. */
  angle: number;
  verticalLength: number;
}

const RAD_TO_DEG = 180 / Math.PI;

function isFiniteLandmark(point: Landmark | undefined): point is Landmark {
  return Boolean(
    point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  );
}

/** Normalize an axial angle: 180 degrees describes the same shoulder line. */
export function normalizeAxialAngle(angle: number): number {
  let normalized = ((((angle + 90) % 180) + 180) % 180) - 90;
  if (Object.is(normalized, -0)) normalized = 0;
  return normalized;
}

export function axialAngleDifference(a: number, b: number): number {
  return normalizeAxialAngle(a - b);
}

function axisYaw(a: Landmark | undefined, b: Landmark | undefined): number | null {
  if (!isFiniteLandmark(a) || !isFiniteLandmark(b)) return null;

  const dx = a.x - b.x;
  const dz = a.z - b.z;
  if (Math.hypot(dx, dz) < 0.03) return null;

  return normalizeAxialAngle(Math.atan2(dz, dx) * RAD_TO_DEG);
}

function meanAxialAngle(angles: number[]): number {
  const doubled = angles.map((angle) => (angle * 2) / RAD_TO_DEG);
  const x = doubled.reduce((sum, angle) => sum + Math.cos(angle), 0);
  const y = doubled.reduce((sum, angle) => sum + Math.sin(angle), 0);
  return normalizeAxialAngle((Math.atan2(y, x) * RAD_TO_DEG) / 2);
}

/**
 * Estimate torso yaw in the camera coordinate system from the shoulder and hip
 * axes. The result is an orientation line, so it is normalized to [-90, 90].
 */
export function estimateBodyYaw(worldLandmarks: Landmark[]): BodyYawEstimate | null {
  const shoulderAngle = axisYaw(worldLandmarks[11], worldLandmarks[12]);
  if (shoulderAngle === null) return null;

  const hipAngle = axisYaw(worldLandmarks[23], worldLandmarks[24]);
  const agreement =
    hipAngle === null ? null : Math.abs(axialAngleDifference(shoulderAngle, hipAngle));
  const usableHipAngle = hipAngle !== null && agreement !== null && agreement <= 30;
  const angle = usableHipAngle ? meanAxialAngle([shoulderAngle, hipAngle]) : shoulderAngle;

  return { angle, shoulderAngle, hipAngle, agreement };
}

/**
 * Estimate signed torso recline in the body's sagittal plane. The shoulder axis
 * defines a body-local forward direction, so the result remains useful when the
 * camera views the person from the side or at an oblique angle.
 */
export function estimateTorsoRecline(
  worldLandmarks: Landmark[]
): TorsoReclineEstimate | null {
  const leftShoulder = worldLandmarks[11];
  const rightShoulder = worldLandmarks[12];
  const leftHip = worldLandmarks[23];
  const rightHip = worldLandmarks[24];
  if (
    !isFiniteLandmark(leftShoulder) ||
    !isFiniteLandmark(rightShoulder) ||
    !isFiniteLandmark(leftHip) ||
    !isFiniteLandmark(rightHip)
  ) {
    return null;
  }

  const shoulderMid = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
    z: (leftShoulder.z + rightShoulder.z) / 2,
  };
  const hipMid = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
    z: (leftHip.z + rightHip.z) / 2,
  };

  // MediaPipe labels anatomical left/right. In camera coordinates, rotating the
  // right-to-left shoulder axis by -90 degrees gives the body's forward axis.
  const acrossX = leftShoulder.x - rightShoulder.x;
  const acrossZ = leftShoulder.z - rightShoulder.z;
  const acrossLength = Math.hypot(acrossX, acrossZ);
  const verticalLength = hipMid.y - shoulderMid.y;
  if (acrossLength < 0.03 || verticalLength < 0.03) return null;

  const forwardX = acrossZ / acrossLength;
  const forwardZ = -acrossX / acrossLength;
  const torsoX = shoulderMid.x - hipMid.x;
  const torsoZ = shoulderMid.z - hipMid.z;
  const forwardDisplacement = torsoX * forwardX + torsoZ * forwardZ;
  const forwardLean = Math.atan2(forwardDisplacement, verticalLength) * RAD_TO_DEG;

  return {
    angle: round(-forwardLean),
    verticalLength: round(verticalLength, 3),
  };
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function axialMedianAbsoluteDeviation(values: number[], center: number): number {
  return median(values.map((value) => Math.abs(axialAngleDifference(value, center))));
}

function medianAbsoluteDeviation(values: number[], center = median(values)): number {
  return median(values.map((value) => Math.abs(value - center)));
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function summarizeCalibrationPose(
  samples: CalibrationFrameSample[]
): CalibrationPoseSummary {
  if (samples.length === 0) {
    throw new Error("没有足够的有效校准样本");
  }

  const bodyYawValues = samples.map((sample) => sample.bodyYaw);
  const bodyYaw = meanAxialAngle(bodyYawValues);
  const headTilt = median(samples.map((sample) => sample.headTilt));
  const shoulderTilt = median(samples.map((sample) => sample.shoulderTilt));
  const neckForward = median(samples.map((sample) => sample.neckForward));
  const spineTilt = median(samples.map((sample) => sample.spineTilt));
  const agreements = samples
    .map((sample) => sample.yawAgreement)
    .filter((value): value is number => value !== null);
  const torsoReclineValues = samples
    .map((sample) => sample.torsoRecline)
    .filter((value): value is number => value !== null);
  const torsoRecline =
    torsoReclineValues.length > 0 ? median(torsoReclineValues) : null;

  return {
    headTilt: round(headTilt),
    shoulderTilt: round(shoulderTilt),
    neckForward: round(neckForward),
    spineTilt: round(spineTilt),
    metricMad: {
      headTilt: round(
        medianAbsoluteDeviation(
          samples.map((sample) => sample.headTilt),
          headTilt
        )
      ),
      shoulderTilt: round(
        medianAbsoluteDeviation(
          samples.map((sample) => sample.shoulderTilt),
          shoulderTilt
        )
      ),
      neckForward: round(
        medianAbsoluteDeviation(
          samples.map((sample) => sample.neckForward),
          neckForward
        )
      ),
      spineTilt: round(
        medianAbsoluteDeviation(
          samples.map((sample) => sample.spineTilt),
          spineTilt
        )
      ),
    },
    bodyYaw: round(bodyYaw),
    yawMad: round(axialMedianAbsoluteDeviation(bodyYawValues, bodyYaw)),
    yawAgreement: agreements.length > 0 ? round(median(agreements)) : null,
    torsoRecline: torsoRecline === null ? null : round(torsoRecline),
    torsoReclineMad:
      torsoRecline === null
        ? null
        : round(medianAbsoluteDeviation(torsoReclineValues, torsoRecline)),
    sampleCount: samples.length,
  };
}

export function classifyCameraView(cameraYawMagnitude: number): CameraViewMode {
  if (cameraYawMagnitude < 20) return "front";
  if (cameraYawMagnitude < 65) return "oblique";
  return "side";
}

function confidenceFor(
  cameraFacing: CalibrationPoseSummary,
  working: CalibrationPoseSummary
): CalibrationConfidence {
  const enoughSamples = cameraFacing.sampleCount >= 15 && working.sampleCount >= 45;
  const stable = cameraFacing.yawMad <= 5 && working.yawMad <= 5;
  const consistent =
    (cameraFacing.yawAgreement === null || cameraFacing.yawAgreement <= 15) &&
    (working.yawAgreement === null || working.yawAgreement <= 15);

  if (enoughSamples && stable && consistent) return "high";
  if (cameraFacing.sampleCount >= 8 && working.sampleCount >= 20) return "medium";
  return "low";
}

export function createCameraCalibrationProfile(
  cameraFacingSamples: CalibrationFrameSample[],
  workingSamples: CalibrationFrameSample[],
  reclinedSamples: CalibrationFrameSample[] = [],
  reminderSamples: CalibrationFrameSample[] = []
): CameraCalibrationProfile {
  const cameraFacing = summarizeCalibrationPose(cameraFacingSamples);
  const working = summarizeCalibrationPose(workingSamples);
  const reclined = reclinedSamples.length > 0 ? summarizeCalibrationPose(reclinedSamples) : null;
  const reminder = reminderSamples.length > 0 ? summarizeCalibrationPose(reminderSamples) : null;
  const cameraYaw = round(axialAngleDifference(working.bodyYaw, cameraFacing.bodyYaw));
  const cameraYawMagnitude = Math.abs(cameraYaw);
  const minimumDifference: CalibrationMetricValues = {
    headTilt: 3,
    shoulderTilt: 2,
    neckForward: 8,
    spineTilt: 3,
  };
  const metricKeys = Object.keys(minimumDifference) as CalibrationMetricKey[];
  const learnedMetrics = reminder
    ? metricKeys.filter((key) => {
        const separation = Math.abs(reminder[key] - working[key]);
        const noiseFloor = 3 * Math.max(working.metricMad[key], reminder.metricMad[key]);
        return separation >= Math.max(minimumDifference[key], noiseFloor);
      })
    : [];

  return {
    schemaVersion: 4,
    cameraFacing,
    working,
    reclined,
    reminder,
    learnedMetrics,
    cameraYaw,
    cameraYawMagnitude,
    viewMode: classifyCameraView(cameraYawMagnitude),
    confidence: confidenceFor(cameraFacing, working),
  };
}
