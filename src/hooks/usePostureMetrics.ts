"use client";

import { useMemo } from "react";
import { Landmark, NormalizedLandmark } from "@mediapipe/tasks-vision";
import {
  analyzePosture,
  DEFAULT_POSTURE_THRESHOLDS,
  type PersonalPostureBaseline,
  type PostureMetrics,
  type PostureThresholds,
} from "@/lib/posture";

const DEFAULT_METRICS: PostureMetrics = {
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

interface UsePostureMetricsOptions {
  headAngleThreshold?: { warning: number; bad: number };
  shoulderThreshold?: { warning: number; bad: number };
  spineAngleThreshold?: { warning: number; bad: number };
  /** Personal posture baseline — when provided, thresholds become |baseline| + tolerance */
  baseline?: PersonalPostureBaseline | null;
  worldLandmarks?: Landmark[][] | null;
}

export function usePostureMetrics(
  landmarks: NormalizedLandmark[][] | null,
  options: UsePostureMetricsOptions = {}
): PostureMetrics {
  return useMemo(() => {
    if (!landmarks || landmarks.length === 0) return DEFAULT_METRICS;

    let thresholds: PostureThresholds;

    if (options.baseline) {
      // Personal baseline mode: thresholds = |baseline| + tolerance
      thresholds = {
        headAngle: {
          warning: Math.abs(options.baseline.headTilt) + 10,
          bad: Math.abs(options.baseline.headTilt) + 20,
        },
        shoulder: {
          warning: Math.abs(options.baseline.shoulderTilt) + 8,
          bad: Math.abs(options.baseline.shoulderTilt) + 15,
        },
        spineAngle: {
          warning: Math.abs(options.baseline.spineTilt) + 6,
          bad: Math.abs(options.baseline.spineTilt) + 12,
        },
      };
    } else {
      // Default mode: use provided thresholds or global defaults
      thresholds = {
        headAngle: options.headAngleThreshold ?? DEFAULT_POSTURE_THRESHOLDS.headAngle,
        shoulder: options.shoulderThreshold ?? DEFAULT_POSTURE_THRESHOLDS.shoulder,
        spineAngle: options.spineAngleThreshold ?? DEFAULT_POSTURE_THRESHOLDS.spineAngle,
      };
    }

    return analyzePosture(
      landmarks[0],
      thresholds,
      options.baseline,
      options.worldLandmarks?.[0]
    );
  }, [
    landmarks,
    options.headAngleThreshold,
    options.shoulderThreshold,
    options.spineAngleThreshold,
    options.baseline,
    options.worldLandmarks,
  ]);
}
