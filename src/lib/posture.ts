import { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  estimateTorsoRecline,
  type CalibrationMetricKey,
  type CalibrationMetricValues,
  type CameraCalibrationProfile,
} from "@/lib/calibration";

export type PostureStatus = "good" | "warning" | "bad";

export interface PostureThresholds {
  headAngle: { warning: number; bad: number };
  shoulder: { warning: number; bad: number };
  spineAngle: { warning: number; bad: number };
}

export interface PostureMetrics {
  headTiltAngle: number;      // 头部倾斜（度），ear-to-ear line from horizontal, 0=level
  shoulderTiltAngle: number;  // 肩膀倾斜（度），shoulder line from horizontal, 0=level
  neckForwardScore: number;   // 脖子前倾程度（0-100），0=正常，越高越严重
  spineTiltAngle: number;     // 脊椎倾斜（度），shoulder-to-hip from vertical, 0=straight
  torsoReclineAngle: number | null; // 躯干后仰角（度），正数=后仰，负数=前倾
  activeGoodPose: "working" | "reclined" | null;
  metricScores: CalibrationMetricValues; // 各子项 0-100，越高越好
  metricDeviations: CalibrationMetricValues; // 相对当前良好姿势中心的绝对偏差
  angleSource: "image2d" | "mixed" | "world3d";
  overallScore: number;       // 总评分（0-100），越高越好
  status: PostureStatus;
  isDetected: boolean;
}

export interface PersonalPostureBaseline {
  headTilt: number;
  shoulderTilt: number;
  neckForward: number;
  spineTilt: number;
  calibration?: CameraCalibrationProfile;
}

interface Point {
  x: number;
  y: number;
}

function getMidpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

// Angle of a line between two points from the horizontal axis (0° = level, 90° = vertical)
// Always returns 0-90° as the "tilt" from horizontal
function tiltFromHorizontal(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const angle = Math.abs(Math.atan2(dy, dx) * (180 / Math.PI));
  // Normalize to 0-90°: 0 = perfectly horizontal, 90 = perfectly vertical
  return angle > 90 ? 180 - angle : angle;
}

// Angle of a line between two points from the vertical axis (0° = straight up, 90° = horizontal)
function tiltFromVertical(top: Point, bottom: Point): number {
  const dx = top.x - bottom.x;
  const dy = Math.abs(bottom.y - top.y);
  if (dy < 0.001) return 0;
  return Math.abs(Math.atan2(dx, dy) * (180 / Math.PI));
}

// ── Metric 1: Head Tilt ──
// Uses ear-to-ear line angle from horizontal.
// When head is upright, ears are level → angle ≈ 0°.
// When head tilts sideways (歪头), angle increases.
function calculateHeadTiltAngle(landmarks: NormalizedLandmark[]): number {
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];
  if (!leftEar || !rightEar) return 0;
  return tiltFromHorizontal(leftEar, rightEar);
}

// ── Metric 2: Shoulder Tilt ──
// Uses shoulder-to-shoulder line angle from horizontal.
// When shoulders are level → angle ≈ 0°.
// When one shoulder is higher (耸肩/倾斜), angle increases.
function calculateShoulderTiltAngle(landmarks: NormalizedLandmark[]): number {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  if (!leftShoulder || !rightShoulder) return 0;
  return tiltFromHorizontal(leftShoulder, rightShoulder);
}

function calculateWorldAxisTilt(
  a: Landmark | undefined,
  b: Landmark | undefined
): number | null {
  if (
    !a ||
    !b ||
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.y) ||
    !Number.isFinite(a.z) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.y) ||
    !Number.isFinite(b.z)
  ) {
    return null;
  }

  const horizontalDistance = Math.hypot(b.x - a.x, b.z - a.z);
  const verticalDifference = Math.abs(b.y - a.y);
  if (Math.hypot(horizontalDistance, verticalDifference) < 0.001) return null;
  return Math.atan2(verticalDifference, horizontalDistance) * (180 / Math.PI);
}

// ── Metric 3: Forward Neck Score (0-100, higher = worse) ──
// Uses weighted average of two reliable indicators for front-facing webcam:
//
// A) Vertical ratio (weight 60%): (shoulderMidY - noseY) / shoulderWidth
//    When neck is pushed forward, the head drops toward shoulders, ratio decreases.
//    Good posture: ratio >= 0.35 | Forward neck: ratio <= 0.18
//    Note: thresholds are lenient because webcam height/distance varies widely.
//    Baseline calibration is the recommended way to get personalized accuracy.
//
// B) Head pitch (weight 40%): nose vertical position relative to ear midpoint
//    Detects looking up (仰头) or looking down (低头) which often accompanies
//    forward neck posture.
//    Normal upright: pitchRatio ≈ 0.5-0.8 (nose below ears)
//    Looking up: pitchRatio < 0.35 (nose rises toward ear level)
//    Looking down: pitchRatio > 0.95 (nose drops further)
function calculateNeckForwardScore(
  landmarks: NormalizedLandmark[],
  baseline?: { neckForward: number }
): number {
  const nose = landmarks[0];
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftEar = landmarks[7];
  const rightEar = landmarks[8];

  if (!nose || !leftShoulder || !rightShoulder) return 0;

  const shoulderMid = getMidpoint(leftShoulder, rightShoulder);
  const shoulderWidth = distance(leftShoulder, rightShoulder);
  if (shoulderWidth < 0.001) return 0;

  // ── Indicator A: vertical ratio (60% weight) ──
  const verticalGap = shoulderMid.y - nose.y;
  const verticalRatio = verticalGap / shoulderWidth;

  // If baseline exists, center the thresholds around the baseline ratio
  // Default thresholds are lenient to avoid false positives across camera setups
  // NOTE: baseline.neckForward from BaselineSampling stores neckForwardScore (0-100),
  // but we need the verticalRatio (0-1). We normalize: if value > 1.0, it's a
  // severity score and we map it back to an approximate ratio via scoreFromBadness inverse.
  // A score of 0 (perfect) ≈ ratio 0.45, score of 100 (terrible) ≈ ratio 0.12
  const baselineRatio = baseline
    ? (baseline.neckForward > 1.0
      ? Math.max(0.12, 0.45 - (baseline.neckForward / 100) * 0.33)  // map 0-100 → 0.45-0.12
      : baseline.neckForward)
    : null;
  const goodRatio = baselineRatio !== null ? Math.max(0.20, baselineRatio - 0.10) : 0.35;
  const badRatio = baselineRatio !== null ? Math.max(0.12, baselineRatio - 0.20) : 0.18;

  let verticalScore = 0;
  if (verticalRatio <= badRatio) {
    verticalScore = 100;
  } else if (verticalRatio >= goodRatio) {
    verticalScore = 0;
  } else {
    verticalScore = ((goodRatio - verticalRatio) / (goodRatio - badRatio)) * 100;
  }

  // ── Indicator B: head pitch (40% weight) ──
  // Uses nose vertical position relative to ear midpoint, normalized by ear distance.
  let headPitchScore = 0;
  if (leftEar && rightEar) {
    const earMid = getMidpoint(leftEar, rightEar);
    const earToNoseDy = nose.y - earMid.y; // positive = nose below ears (normal)
    const earDist = distance(leftEar, rightEar);
    if (earDist > 0.001) {
      const pitchRatio = earToNoseDy / earDist;

      // Normal upright: pitchRatio ≈ 0.5-0.8 (nose below ears)
      // Looking up (仰头): pitchRatio < 0.35 → head tilts back
      // Looking down (低头): pitchRatio > 0.95 → head tilts forward
      if (pitchRatio < 0.25) {
        headPitchScore = 100; // extreme looking up
      } else if (pitchRatio < 0.35) {
        headPitchScore = ((0.35 - pitchRatio) / (0.35 - 0.25)) * 100;
      } else if (pitchRatio <= 0.85) {
        headPitchScore = 0; // healthy range
      } else if (pitchRatio <= 1.1) {
        headPitchScore = ((pitchRatio - 0.85) / (1.1 - 0.85)) * 100;
      } else {
        headPitchScore = 100; // extreme looking down
      }
    }
  }

  // Weighted average: vertical ratio is primary, head pitch is secondary
  return Math.round(verticalScore * 0.6 + headPitchScore * 0.4);
}

// ── Metric 4: Spine Tilt ──
// Uses shoulder-midpoint to hip-midpoint line angle from vertical.
// When sitting straight → angle ≈ 0°.
// When leaning sideways → angle increases.
function calculateSpineTiltAngle(landmarks: NormalizedLandmark[]): number {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) return 0;
  const shoulderMid = getMidpoint(leftShoulder, rightShoulder);
  const hipMid = getMidpoint(leftHip, rightHip);
  return tiltFromVertical(shoulderMid, hipMid);
}

// ── Scoring helpers ──

// Convert a "badness" metric (lower = better) to a 0-100 score (higher = better)
function scoreFromBadness(value: number, goodThreshold: number, badThreshold: number): number {
  if (value <= goodThreshold) return 100;
  if (value >= badThreshold) return 0;
  return Math.round(100 * (1 - (value - goodThreshold) / (badThreshold - goodThreshold)));
}

function scoreFromPersonalExample(value: number, goodValue: number, reminderValue: number): number {
  const delta = reminderValue - goodValue;
  if (Math.abs(delta) < 0.001) return 100;
  const progress = (value - goodValue) / delta;
  return scoreFromBadness(progress, 0.35, 0.85);
}

function scoreFromBaselineDeviation(
  value: number,
  baseline: number,
  warningTolerance: number,
  badTolerance: number
): number {
  return scoreFromBadness(Math.abs(value - baseline), warningTolerance, badTolerance);
}

const PERSONAL_TOLERANCES: Record<CalibrationMetricKey, { warning: number; bad: number }> = {
  headTilt: { warning: 10, bad: 20 },
  shoulderTilt: { warning: 8, bad: 15 },
  neckForward: { warning: 15, bad: 35 },
  spineTilt: { warning: 6, bad: 12 },
};

function personalScore(
  key: CalibrationMetricKey,
  value: number,
  baseline: PersonalPostureBaseline,
  reference: CalibrationMetricValues,
  allowReminderModel: boolean
): number {
  const profile = baseline.calibration;
  const reminder = profile?.reminder;
  if (profile && reminder && allowReminderModel && profile.learnedMetrics.includes(key)) {
    return scoreFromPersonalExample(value, profile.working[key], reminder[key]);
  }

  return scoreFromBaselineDeviation(
    value,
    reference[key],
    PERSONAL_TOLERANCES[key].warning,
    PERSONAL_TOLERANCES[key].bad
  );
}

function distanceToGoodPose(
  current: CalibrationMetricValues,
  reference: CalibrationMetricValues,
  currentRecline: number | null,
  referenceRecline: number | null | undefined
): number {
  const metricKeys = Object.keys(PERSONAL_TOLERANCES) as CalibrationMetricKey[];
  let squaredDistance = metricKeys.reduce((sum, key) => {
    const scale = PERSONAL_TOLERANCES[key].warning;
    return sum + ((current[key] - reference[key]) / scale) ** 2;
  }, 0);
  let dimensions = metricKeys.length;

  if (currentRecline !== null && typeof referenceRecline === "number") {
    squaredDistance += ((currentRecline - referenceRecline) / 10) ** 2;
    dimensions += 1;
  }

  return squaredDistance / dimensions;
}

function selectGoodPose(
  baseline: PersonalPostureBaseline,
  current: CalibrationMetricValues,
  torsoReclineAngle: number | null
): {
  reference: CalibrationMetricValues;
  kind: "working" | "reclined";
} {
  const profile = baseline.calibration;
  const working = profile?.working ?? baseline;
  const reclined = profile?.reclined;
  const workingAngle = profile?.working.torsoRecline;
  const reclinedAngle = reclined?.torsoRecline;

  if (reclined) {
    const workingDistance = distanceToGoodPose(
      current,
      working,
      torsoReclineAngle,
      workingAngle
    );
    const reclinedDistance = distanceToGoodPose(
      current,
      reclined,
      torsoReclineAngle,
      reclinedAngle
    );
    if (reclinedDistance < workingDistance) {
      return { reference: reclined, kind: "reclined" };
    }
  }

  return { reference: working, kind: "working" };
}

export const DEFAULT_POSTURE_THRESHOLDS: PostureThresholds = {
  headAngle: { warning: 8, bad: 20 },
  shoulder: { warning: 5, bad: 12 },
  spineAngle: { warning: 8, bad: 20 },
};

export function analyzePosture(
  landmarks: NormalizedLandmark[],
  thresholds: PostureThresholds = DEFAULT_POSTURE_THRESHOLDS,
  baseline?: PersonalPostureBaseline | null,
  worldLandmarks?: Landmark[] | null
): PostureMetrics {
  // Check if essential landmarks exist and have valid coordinates.
  // Note: MediaPipe pose_landmarker_lite often returns visibility=0 or undefined
  // even when landmarks are clearly detected, so we do NOT use visibility threshold.
  // We only require that the landmark object exists with valid x,y coordinates.
  const hasValidLandmark = (i: number): boolean => {
    const lm = landmarks[i];
    if (!lm) return false;
    if (typeof lm.x !== "number" || typeof lm.y !== "number") return false;
    // Sanity check: coordinates should be in normalized [0, 1] range
    if (lm.x < -0.1 || lm.x > 1.1 || lm.y < -0.1 || lm.y > 1.1) return false;
    return true;
  };

  // Core landmarks needed for head + shoulder metrics (upper body)
  const coreIndices = [0, 11, 12]; // nose, left shoulder, right shoulder
  const coreDetected = coreIndices.every(hasValidLandmark);

  // Hip landmarks are needed for spine tilt, but may be off-screen in close-up shots
  const hipIndices = [23, 24]; // left hip, right hip
  const hipsDetected = hipIndices.every(hasValidLandmark);

  // Ear landmarks for head tilt (may occasionally be occluded)
  const earIndices = [7, 8];
  const earsDetected = earIndices.every(hasValidLandmark);

  if (!coreDetected) {
    // Can't do anything without nose and shoulders
    return {
      headTiltAngle: 0,
      shoulderTiltAngle: 0,
      neckForwardScore: 0,
      spineTiltAngle: 0,
      torsoReclineAngle: null,
      activeGoodPose: null,
      metricScores: { headTilt: 0, shoulderTilt: 0, neckForward: 0, spineTilt: 0 },
      metricDeviations: { headTilt: 0, shoulderTilt: 0, neckForward: 0, spineTilt: 0 },
      angleSource: "image2d",
      overallScore: 0,
      status: "good",
      isDetected: false,
    };
  }

  // Compute metrics, using 0 for unavailable ones
  // Profiles captured before schema v4 contain image-space angles. Keep using
  // those values until recalibration so existing personal baselines stay valid.
  const usesLegacyImageAngles = Boolean(
    baseline?.calibration && baseline.calibration.schemaVersion < 4
  );
  const worldHeadTilt =
    !usesLegacyImageAngles && worldLandmarks
      ? calculateWorldAxisTilt(worldLandmarks[7], worldLandmarks[8])
      : null;
  const worldShoulderTilt =
    !usesLegacyImageAngles && worldLandmarks
      ? calculateWorldAxisTilt(worldLandmarks[11], worldLandmarks[12])
      : null;
  const headTiltAngle = earsDetected
    ? (worldHeadTilt ?? calculateHeadTiltAngle(landmarks))
    : 0;
  const shoulderTiltAngle = worldShoulderTilt ?? calculateShoulderTiltAngle(landmarks);
  const worldAngleCount = Number(worldHeadTilt !== null) + Number(worldShoulderTilt !== null);
  const angleSource = worldAngleCount === 2 ? "world3d" : worldAngleCount === 1 ? "mixed" : "image2d";
  // Versioned calibration compares the raw metric against captured examples.
  // Legacy baselines retain their historical ratio remapping for compatibility.
  const neckForwardScore = calculateNeckForwardScore(
    landmarks,
    baseline && !baseline.calibration ? baseline : undefined
  );
  const spineTiltAngle = hipsDetected ? calculateSpineTiltAngle(landmarks) : 0;
  const torsoReclineAngle = worldLandmarks
    ? (estimateTorsoRecline(worldLandmarks)?.angle ?? null)
    : null;
  const currentValues: CalibrationMetricValues = {
    headTilt: headTiltAngle,
    shoulderTilt: shoulderTiltAngle,
    neckForward: neckForwardScore,
    spineTilt: spineTiltAngle,
  };
  const goodPose = baseline?.calibration
    ? selectGoodPose(baseline, currentValues, torsoReclineAngle)
    : null;

  // Individual scores (0-100, higher = better posture)
  // Head tilt (only scored if ears detected)
  const headScore = earsDetected
    ? baseline?.calibration
      ? personalScore(
          "headTilt",
          headTiltAngle,
          baseline,
          goodPose?.reference ?? baseline,
          goodPose?.kind !== "reclined"
        )
      : scoreFromBadness(headTiltAngle, thresholds.headAngle.warning, thresholds.headAngle.bad)
    : 100;
  // Shoulder tilt
  const shoulderScore = baseline?.calibration
    ? personalScore(
        "shoulderTilt",
        shoulderTiltAngle,
        baseline,
        goodPose?.reference ?? baseline,
        goodPose?.kind !== "reclined"
      )
    : scoreFromBadness(shoulderTiltAngle, thresholds.shoulder.warning, thresholds.shoulder.bad);
  // Forward neck (good < 20, bad > 60 on the 0-100 severity scale)
  const neckScore = baseline?.calibration
    ? personalScore(
        "neckForward",
        neckForwardScore,
        baseline,
        goodPose?.reference ?? baseline,
        goodPose?.kind !== "reclined"
      )
    : scoreFromBadness(neckForwardScore, 20, 60);
  // Spine tilt (only scored if hips detected)
  const spineScore = hipsDetected
    ? baseline?.calibration
      ? personalScore(
          "spineTilt",
          spineTiltAngle,
          baseline,
          goodPose?.reference ?? baseline,
          goodPose?.kind !== "reclined"
        )
      : scoreFromBadness(spineTiltAngle, thresholds.spineAngle.warning, thresholds.spineAngle.bad)
    : 100;

  // Overall score: weighted average (redistribute weights for unavailable metrics)
  const weights = { head: 0.30, shoulder: 0.20, neck: 0.30, spine: 0.20 };
  const totalWeight =
    (earsDetected ? weights.head : 0) +
    weights.shoulder +
    weights.neck +
    (hipsDetected ? weights.spine : 0);
  const overallScore = Math.round(
    (headScore * (earsDetected ? weights.head : 0) +
      shoulderScore * weights.shoulder +
      neckScore * weights.neck +
      spineScore * (hipsDetected ? weights.spine : 0)) / totalWeight
  );

  // Status based on worst available metric
  const availableScores: number[] = [shoulderScore, neckScore];
  if (earsDetected) availableScores.push(headScore);
  if (hipsDetected) availableScores.push(spineScore);
  const worstScore = Math.min(...availableScores);
  let status: PostureStatus = "good";
  if (worstScore < 50) status = "bad";
  else if (worstScore < 80) status = "warning";

  const activeReference = goodPose?.reference;
  const metricDeviations: CalibrationMetricValues = {
    headTilt: earsDetected
      ? Math.abs(headTiltAngle - (activeReference?.headTilt ?? 0))
      : 0,
    shoulderTilt: Math.abs(shoulderTiltAngle - (activeReference?.shoulderTilt ?? 0)),
    neckForward: Math.abs(neckForwardScore - (activeReference?.neckForward ?? 0)),
    spineTilt: hipsDetected
      ? Math.abs(spineTiltAngle - (activeReference?.spineTilt ?? 0))
      : 0,
  };

  return {
    headTiltAngle: Math.round(headTiltAngle * 10) / 10,
    shoulderTiltAngle: Math.round(shoulderTiltAngle * 10) / 10,
    neckForwardScore: Math.round(neckForwardScore),
    spineTiltAngle: Math.round(spineTiltAngle * 10) / 10,
    torsoReclineAngle,
    activeGoodPose: goodPose?.kind ?? null,
    metricScores: {
      headTilt: headScore,
      shoulderTilt: shoulderScore,
      neckForward: neckScore,
      spineTilt: spineScore,
    },
    metricDeviations: {
      headTilt: Math.round(metricDeviations.headTilt * 10) / 10,
      shoulderTilt: Math.round(metricDeviations.shoulderTilt * 10) / 10,
      neckForward: Math.round(metricDeviations.neckForward),
      spineTilt: Math.round(metricDeviations.spineTilt * 10) / 10,
    },
    angleSource,
    overallScore,
    status,
    isDetected: true,
  };
}
