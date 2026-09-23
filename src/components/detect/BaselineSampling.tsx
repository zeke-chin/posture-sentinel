"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Landmark } from "@mediapipe/tasks-vision";
import {
  createCameraCalibrationProfile,
  estimateBodyYaw,
  estimateTorsoRecline,
  median,
  type CalibrationFrameSample,
  type CameraCalibrationProfile,
} from "@/lib/calibration";
import type { PostureBaseline } from "@/lib/storage";

interface PostureMetrics {
  headTiltAngle: number;
  shoulderTiltAngle: number;
  neckForwardScore: number;
  spineTiltAngle: number;
}

interface BaselineSamplingProps {
  metrics: PostureMetrics | null;
  worldLandmarks: Landmark[] | null;
  isActive: boolean;
  onCapture: (data: Omit<PostureBaseline, "capturedAt">) => void;
  onCancel: () => void;
}

type SamplingPhase = "camera" | "working" | "reclined" | "reminder";
type Phase =
  | "prepare"
  | SamplingPhase
  | "workingPrepare"
  | "reclinedPrepare"
  | "reminderPrepare"
  | "success";

const DURATION_SECONDS: Record<SamplingPhase, number> = {
  camera: 5,
  working: 15,
  reclined: 10,
  reminder: 8,
};

const MIN_SAMPLES: Record<SamplingPhase, number> = {
  camera: 12,
  working: 36,
  reclined: 24,
  reminder: 18,
};

const CALIBRATION_DEBUG = process.env.NODE_ENV !== "production";

type RejectionReason =
  | "metrics-unavailable"
  | "world-landmarks-unavailable"
  | "body-yaw-unavailable"
  | "invalid-metrics"
  | "torso-recline-unavailable"
  | "recline-delta-too-large";

interface DebugCounters {
  accepted: number;
  rejected: Partial<Record<RejectionReason, number>>;
}

const VIEW_LABELS: Record<CameraCalibrationProfile["viewMode"], string> = {
  front: "正面",
  oblique: "斜侧面",
  side: "侧面",
};

function isSamplingPhase(phase: Phase): phase is SamplingPhase {
  return (
    phase === "camera" ||
    phase === "working" ||
    phase === "reclined" ||
    phase === "reminder"
  );
}

function createEmptySamples(): Record<SamplingPhase, CalibrationFrameSample[]> {
  return { camera: [], working: [], reclined: [], reminder: [] };
}

function createDebugCounters(): DebugCounters {
  return { accepted: 0, rejected: {} };
}

function isFiniteLandmark(point: Landmark | undefined): boolean {
  return Boolean(
    point && Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z)
  );
}

function getSampleRejectionReason(
  metrics: PostureMetrics | null,
  worldLandmarks: Landmark[] | null,
  sample: CalibrationFrameSample | null
): RejectionReason | null {
  if (!metrics) return "metrics-unavailable";
  if (!worldLandmarks) return "world-landmarks-unavailable";
  if (!estimateBodyYaw(worldLandmarks)) return "body-yaw-unavailable";
  if (
    ![
      metrics.headTiltAngle,
      metrics.shoulderTiltAngle,
      metrics.neckForwardScore,
      metrics.spineTiltAngle,
    ].every(Number.isFinite)
  ) {
    return "invalid-metrics";
  }
  if (!sample) return "body-yaw-unavailable";
  return null;
}

function getReclinedRejectionReason(
  metrics: PostureMetrics | null,
  worldLandmarks: Landmark[] | null,
  sample: CalibrationFrameSample | null,
  workingRecline: number | null
): RejectionReason | null {
  const sampleReason = getSampleRejectionReason(metrics, worldLandmarks, sample);
  if (sampleReason) return sampleReason;
  if (sample?.torsoRecline === null || sample?.torsoRecline === undefined) {
    return "torso-recline-unavailable";
  }
  if (workingRecline !== null && sample.torsoRecline - workingRecline > 35) {
    return "recline-delta-too-large";
  }
  return null;
}

function getReclineDebugDetails(
  worldLandmarks: Landmark[] | null,
  sample: CalibrationFrameSample | null,
  workingRecline: number | null
) {
  const leftShoulder = worldLandmarks?.[11];
  const rightShoulder = worldLandmarks?.[12];
  const leftHip = worldLandmarks?.[23];
  const rightHip = worldLandmarks?.[24];
  const shouldersValid = isFiniteLandmark(leftShoulder) && isFiniteLandmark(rightShoulder);
  const hipsValid = isFiniteLandmark(leftHip) && isFiniteLandmark(rightHip);
  const shoulderAxisLength =
    shouldersValid && leftShoulder && rightShoulder
      ? Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.z - rightShoulder.z)
      : null;
  const torsoVerticalLength =
    shouldersValid && hipsValid && leftShoulder && rightShoulder && leftHip && rightHip
      ? (leftHip.y + rightHip.y - leftShoulder.y - rightShoulder.y) / 2
      : null;

  return {
    worldLandmarkCount: worldLandmarks?.length ?? 0,
    shouldersValid,
    hipsValid,
    shoulderAxisLength: shoulderAxisLength?.toFixed(3) ?? null,
    torsoVerticalLength: torsoVerticalLength?.toFixed(3) ?? null,
    bodyYaw: sample?.bodyYaw ?? null,
    workingRecline,
    currentRecline: sample?.torsoRecline ?? null,
    reclineDelta:
      sample?.torsoRecline !== null &&
      sample?.torsoRecline !== undefined &&
      workingRecline !== null
        ? Number((sample.torsoRecline - workingRecline).toFixed(1))
        : null,
  };
}

function getReclinedFailureMessage(counters: DebugCounters): string {
  const ranked = Object.entries(counters.rejected).sort(([, a], [, b]) => (b ?? 0) - (a ?? 0));
  const mainReason = ranked[0]?.[0] as RejectionReason | undefined;
  if (mainReason === "torso-recline-unavailable" || mainReason === "world-landmarks-unavailable") {
    return "没有取得稳定的髋部三维关键点，请调整镜头以同时看到双肩和髋部";
  }
  if (mainReason === "recline-delta-too-large") {
    return "检测到的后仰幅度超过 35°，请回到舒适工作角度后重试";
  }
  return "有效关键点不足，请确保摄像头能看到头部、双肩和髋部后重试";
}

function toSample(
  metrics: PostureMetrics | null,
  worldLandmarks: Landmark[] | null
): CalibrationFrameSample | null {
  if (!metrics || !worldLandmarks) return null;
  const yaw = estimateBodyYaw(worldLandmarks);
  if (!yaw) return null;
  const torsoRecline = estimateTorsoRecline(worldLandmarks);

  const values = [
    metrics.headTiltAngle,
    metrics.shoulderTiltAngle,
    metrics.neckForwardScore,
    metrics.spineTiltAngle,
  ];
  if (!values.every(Number.isFinite)) return null;

  return {
    headTilt: metrics.headTiltAngle,
    shoulderTilt: metrics.shoulderTiltAngle,
    neckForward: metrics.neckForwardScore,
    spineTilt: metrics.spineTiltAngle,
    bodyYaw: yaw.angle,
    yawAgreement: yaw.agreement,
    torsoRecline: torsoRecline?.angle ?? null,
  };
}

export default function BaselineSampling({
  metrics,
  worldLandmarks,
  isActive,
  onCapture,
  onCancel,
}: BaselineSamplingProps) {
  const [phase, setPhase] = useState<Phase>("prepare");
  const [remainingMs, setRemainingMs] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");
  const [profile, setProfile] = useState<CameraCalibrationProfile | null>(null);
  const [workingRecline, setWorkingRecline] = useState<number | null>(null);
  const [sampleCounts, setSampleCounts] = useState<Record<SamplingPhase, number>>({
    camera: 0,
    working: 0,
    reclined: 0,
    reminder: 0,
  });
  const samplesRef = useRef(createEmptySamples());
  const debugCountersRef = useRef<Record<SamplingPhase, DebugCounters>>({
    camera: createDebugCounters(),
    working: createDebugCounters(),
    reclined: createDebugCounters(),
    reminder: createDebugCounters(),
  });
  const lastDebugLogRef = useRef({ reason: "", timestamp: 0 });
  const deadlineRef = useRef(0);
  const onCaptureRef = useRef(onCapture);

  useEffect(() => {
    onCaptureRef.current = onCapture;
  }, [onCapture]);

  const currentSample = toSample(metrics, worldLandmarks);
  const cameraFacingOk = currentSample !== null && Math.abs(currentSample.bodyYaw) <= 25;
  const reclineDelta =
    currentSample?.torsoRecline !== null &&
    currentSample?.torsoRecline !== undefined &&
    workingRecline !== null
      ? currentSample.torsoRecline - workingRecline
      : null;
  const reclinedPoseOk =
    currentSample?.torsoRecline !== null &&
    currentSample?.torsoRecline !== undefined &&
    (reclineDelta === null || reclineDelta <= 35);
  const quality =
    currentSample === null
      ? "waiting"
      : phase === "camera" && !cameraFacingOk
        ? "adjust"
        : phase === "reclined" && !reclinedPoseOk
          ? "adjust"
          : "good";
  const qualityMessage =
    currentSample === null
      ? "正在寻找肩膀和髋部关键点"
      : phase === "camera" && !cameraFacingOk
        ? "请让肩膀和身体正对摄像头"
        : phase === "reclined" && currentSample.torsoRecline === null
          ? "请让画面同时看到双肩和髋部"
          : phase === "reclined" && reclineDelta !== null && reclineDelta > 35
            ? "后仰幅度过大，请回到舒适工作角度"
        : "数据稳定，请保持当前姿势";

  useEffect(() => {
    if (!isSamplingPhase(phase)) return;
    const sample = toSample(metrics, worldLandmarks);
    if (phase === "reclined") {
      const reason = getReclinedRejectionReason(
        metrics,
        worldLandmarks,
        sample,
        workingRecline
      );
      const counters = debugCountersRef.current.reclined;
      if (reason) {
        counters.rejected[reason] = (counters.rejected[reason] ?? 0) + 1;
      } else {
        counters.accepted += 1;
      }

      if (CALIBRATION_DEBUG) {
        const now = Date.now();
        const logKey = reason ?? "accepted";
        const shouldLog =
          logKey !== lastDebugLogRef.current.reason ||
          now - lastDebugLogRef.current.timestamp >= 1000;
        if (shouldLog) {
          lastDebugLogRef.current = { reason: logKey, timestamp: now };
          console.debug("[姿态校准][舒适后仰]", {
            result: reason ?? "accepted",
            ...getReclineDebugDetails(worldLandmarks, sample, workingRecline),
          });
        }
      }

      if (reason) return;
    }
    if (!sample) return;
    if (phase === "camera" && Math.abs(sample.bodyYaw) > 25) return;
    samplesRef.current[phase].push(sample);
    setSampleCounts((counts) => ({
      ...counts,
      [phase]: samplesRef.current[phase].length,
    }));
  }, [metrics, worldLandmarks, phase, workingRecline]);

  const finishCalibration = useCallback((includeReminder: boolean) => {
    try {
      const nextProfile = createCameraCalibrationProfile(
        samplesRef.current.camera,
        samplesRef.current.working,
        samplesRef.current.reclined,
        includeReminder ? samplesRef.current.reminder : []
      );
      const working = nextProfile.working;
      onCaptureRef.current({
        headTilt: working.headTilt,
        shoulderTilt: working.shoulderTilt,
        neckForward: working.neckForward,
        spineTilt: working.spineTilt,
        calibration: nextProfile,
      });
      setProfile(nextProfile);
      setErrorMessage("");
      setPhase("success");
    } catch {
      setErrorMessage("有效数据不足，请重新采集日常工作姿势");
      setPhase("workingPrepare");
    }
  }, []);

  const completeStage = useCallback(
    (stage: SamplingPhase) => {
      const sampleCount = samplesRef.current[stage].length;
      if (CALIBRATION_DEBUG) {
        console.debug("[姿态校准][阶段完成]", {
          stage,
          acceptedSamples: sampleCount,
          minimumSamples: MIN_SAMPLES[stage],
          diagnostics: debugCountersRef.current[stage],
        });
      }
      if (sampleCount < MIN_SAMPLES[stage]) {
        setErrorMessage(
          stage === "reclined"
            ? getReclinedFailureMessage(debugCountersRef.current.reclined)
            : "有效关键点不足，请确保摄像头能看到头部、双肩和髋部后重试"
        );
        if (stage === "camera") setPhase("prepare");
        else if (stage === "working") setPhase("workingPrepare");
        else if (stage === "reclined") setPhase("reclinedPrepare");
        else setPhase("reminderPrepare");
        return;
      }

      setErrorMessage("");
      if (stage === "camera") setPhase("workingPrepare");
      else if (stage === "working") {
        const reclineValues = samplesRef.current.working
          .map((sample) => sample.torsoRecline)
          .filter((value): value is number => value !== null);
        setWorkingRecline(reclineValues.length > 0 ? median(reclineValues) : null);
        setPhase("reclinedPrepare");
      } else if (stage === "reclined") setPhase("reminderPrepare");
      else finishCalibration(true);
    },
    [finishCalibration]
  );

  useEffect(() => {
    if (!isSamplingPhase(phase)) return;
    const stage = phase;
    const interval = window.setInterval(() => {
      const remaining = Math.max(0, deadlineRef.current - Date.now());
      setRemainingMs(remaining);
      if (remaining === 0) {
        window.clearInterval(interval);
        completeStage(stage);
      }
    }, 100);
    return () => window.clearInterval(interval);
  }, [phase, completeStage]);

  const startStage = useCallback((stage: SamplingPhase) => {
    samplesRef.current[stage] = [];
    debugCountersRef.current[stage] = createDebugCounters();
    lastDebugLogRef.current = { reason: "", timestamp: 0 };
    setSampleCounts((counts) => ({ ...counts, [stage]: 0 }));
    const durationMs = DURATION_SECONDS[stage] * 1000;
    deadlineRef.current = Date.now() + durationMs;
    setRemainingMs(durationMs);
    setErrorMessage("");
    setPhase(stage);
    if (CALIBRATION_DEBUG) {
      console.debug("[姿态校准][阶段开始]", {
        stage,
        durationSeconds: DURATION_SECONDS[stage],
        minimumSamples: MIN_SAMPLES[stage],
      });
    }
  }, []);

  const countdown = Math.max(0, Math.ceil(remainingMs / 1000));
  const duration = isSamplingPhase(phase) ? DURATION_SECONDS[phase] : 1;
  const progress = isSamplingPhase(phase) ? 1 - remainingMs / (duration * 1000) : 0;
  const circumference = 2 * Math.PI * 52;
  const dashOffset = circumference * (1 - progress);

  const renderSampling = (stage: SamplingPhase) => (
    <div className="text-center">
      <div className="flex justify-center gap-2 mb-5" aria-label="校准进度">
        {["camera", "working", "reclined", "reminder"].map((item, index) => {
          const currentIndex = ["camera", "working", "reclined", "reminder"].indexOf(stage);
          return (
            <span
              key={item}
              className={`h-2 rounded-full transition-all ${index <= currentIndex ? "bg-primary w-8" : "bg-border w-5"}`}
            />
          );
        })}
      </div>

      <div className="relative w-32 h-32 mx-auto mb-4">
        <svg viewBox="0 0 120 120" className="w-full h-full -rotate-90">
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            className="text-border"
          />
          <circle
            cx="60"
            cy="60"
            r="52"
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            className={quality === "good" ? "text-primary" : "text-warning"}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-bold text-text-primary tabular-nums">{countdown}</span>
          <span className="text-xs text-text-muted">秒</span>
        </div>
      </div>

      <div
        className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium mb-5 ${
          quality === "good"
            ? "bg-primary-light text-primary-text"
            : quality === "adjust"
              ? "bg-warning-light text-warning-text"
              : "bg-surface-alt text-text-muted"
        }`}
      >
        {qualityMessage}
      </div>

      <p className="text-xs text-text-muted mb-5">
        已采集 {sampleCounts[stage]} 个有效样本，视频和关键点不会上传
      </p>
      <button
        onClick={onCancel}
        className="w-full bg-surface-alt hover:bg-border text-text-secondary font-medium py-3 rounded-xl transition-colors text-sm min-h-11"
      >
        取消校准
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-dark/60 backdrop-blur-sm p-4">
      <div className="bg-surface rounded-3xl p-6 sm:p-8 max-w-md w-full shadow-2xl">
        <h3 className="text-xl font-bold text-text-primary text-center mb-2">
          {phase === "prepare" && "第一步：摄像头零位"}
          {phase === "camera" && "请面向摄像头"}
          {phase === "workingPrepare" && "第二步：日常工作姿势"}
          {phase === "working" && "请看向主显示器"}
          {phase === "reclinedPrepare" && "第三步：舒适后仰（可跳过）"}
          {phase === "reclined" && "靠住椅背和颈托"}
          {phase === "reminderPrepare" && "第四步：提醒姿势（可跳过）"}
          {phase === "reminder" && "保持常见的不良姿势"}
          {phase === "success" && "校准完成"}
        </h3>
        <p className="text-sm text-text-secondary text-center mb-6 leading-relaxed">
          {phase === "prepare" && "身体和肩膀正对摄像头，用于建立摄像头方向参考。"}
          {phase === "camera" && "保持自然坐直，肩膀放松，不需要盯住摄像头。"}
          {phase === "workingPrepare" && "转回你平时工作的方向，正对主显示器并保持舒适坐直。"}
          {phase === "working" && "系统正在记录真实工作基线和摄像头夹角。"}
          {phase === "reclinedPrepare" &&
            "如果你会靠着人体工学椅工作，请采集这个同样健康、舒适的良好姿势。"}
          {phase === "reclined" &&
            "背部贴住椅背，头部自然靠近颈托，保持头颈与躯干对齐。"}
          {phase === "reminderPrepare" &&
            "先离开颈托、回到日常工作位置，再自然做出希望系统提醒的轻微含胸或低头姿势。"}
          {phase === "reminder" && "保持这个常见姿势，系统只学习与良好基线差异明显的指标。"}
          {phase === "success" &&
            `已保存工作基线${profile?.reclined ? "、舒适后仰" : ""}、摄像头视角和提醒设置。`}
        </p>

        {errorMessage && (
          <p className="bg-warning-light text-warning-text rounded-xl px-4 py-3 text-sm mb-4">
            {errorMessage}
          </p>
        )}

        {phase === "prepare" && (
          <div>
            <div className="bg-surface-alt rounded-xl p-4 mb-5 text-xs text-text-secondary leading-relaxed">
              请确保画面能看到头部、双肩，最好还能看到髋部。第一段只建立方向参考，不会成为日常姿态标准。
            </div>
            <div className="flex gap-3">
              <button
                onClick={onCancel}
                className="flex-1 bg-surface-alt hover:bg-border text-text-secondary font-medium py-3 rounded-xl text-sm min-h-11"
              >
                取消
              </button>
              <button
                onClick={() => startStage("camera")}
                disabled={!isActive}
                className={`flex-1 font-medium py-3 rounded-xl text-sm min-h-11 ${isActive ? "bg-primary-dark hover:bg-primary text-white" : "bg-surface-alt text-text-muted cursor-not-allowed"}`}
              >
                开始 5 秒采样
              </button>
            </div>
          </div>
        )}

        {phase === "camera" && renderSampling("camera")}

        {phase === "workingPrepare" && (
          <div className="text-center">
            <div className="bg-primary-light text-primary-text rounded-xl p-4 mb-5 text-sm leading-relaxed">
              现在请转回主显示器。身体和视线都按平时工作方式摆放，不要为了摄像头改变姿势。
            </div>
            <button
              onClick={() => startStage("working")}
              className="w-full bg-primary-dark hover:bg-primary text-white font-medium py-3 rounded-xl text-sm min-h-11"
            >
              已就位，采集 15 秒
            </button>
          </div>
        )}

        {phase === "working" && renderSampling("working")}

        {phase === "reclinedPrepare" && (
          <div className="text-center">
            <div className="bg-primary-light text-primary-text rounded-xl p-4 mb-5 text-left">
              <p className="text-sm font-medium mb-2">这是第二个良好姿势：</p>
              <ul className="space-y-1.5 text-xs">
                <li>让整个背部受到椅背支撑</li>
                <li>头颈随躯干一起后仰，不要单独仰头</li>
                <li>保持能自然看清主显示器的舒适角度</li>
              </ul>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  samplesRef.current.reclined = [];
                  setSampleCounts((counts) => ({ ...counts, reclined: 0 }));
                  setPhase("reminderPrepare");
                }}
                className="flex-1 bg-surface-alt hover:bg-border text-text-secondary font-medium py-3 rounded-xl text-sm min-h-11"
              >
                跳过
              </button>
              <button
                onClick={() => startStage("reclined")}
                className="flex-1 bg-primary-dark hover:bg-primary text-white font-medium py-3 rounded-xl text-sm min-h-11"
              >
                采集 10 秒
              </button>
            </div>
          </div>
        )}

        {phase === "reclined" && renderSampling("reclined")}

        {phase === "reminderPrepare" && (
          <div className="text-center">
            <div className="bg-surface-alt rounded-xl p-4 mb-5 text-left">
              <p className="text-sm font-medium text-text-primary mb-2">这一段会这样使用：</p>
              <ul className="space-y-1.5 text-xs text-text-secondary">
                <li>只学习与良好姿势差异明显的指标</li>
                <li>不会把示范动作当成医学诊断阈值</li>
                <li>动作太小或数据不稳定时自动退回基线容差</li>
              </ul>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => finishCalibration(false)}
                className="flex-1 bg-surface-alt hover:bg-border text-text-secondary font-medium py-3 rounded-xl text-sm min-h-11"
              >
                跳过
              </button>
              <button
                onClick={() => startStage("reminder")}
                className="flex-1 bg-primary-dark hover:bg-primary text-white font-medium py-3 rounded-xl text-sm min-h-11"
              >
                采集 8 秒
              </button>
            </div>
          </div>
        )}

        {phase === "reminder" && renderSampling("reminder")}

        {phase === "success" && profile && (
          <div className="text-center">
            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className="bg-surface-alt rounded-xl p-3">
                <p className="text-xs text-text-muted mb-1">摄像头夹角</p>
                <p className="text-xl font-bold text-text-primary">
                  约 {profile.cameraYawMagnitude.toFixed(0)}°
                </p>
              </div>
              <div className="bg-surface-alt rounded-xl p-3">
                <p className="text-xs text-text-muted mb-1">检测视角</p>
                <p className="text-xl font-bold text-text-primary">
                  {VIEW_LABELS[profile.viewMode]}
                </p>
              </div>
            </div>
            <p className="text-xs text-text-muted mb-5">
              可信度：
              {profile.confidence === "high"
                ? "高"
                : profile.confidence === "medium"
                  ? "中"
                  : "较低"}
              {profile.learnedMetrics.length > 0
                ? ` · 已学习 ${profile.learnedMetrics.length} 个提醒指标`
                : " · 提醒指标使用基线容差"}
              {profile.reclined?.torsoRecline !== null &&
                profile.reclined?.torsoRecline !== undefined
                ? ` · 舒适后仰约 ${profile.reclined.torsoRecline.toFixed(0)}°`
                : " · 未采集舒适后仰"}
            </p>
            <button
              onClick={onCancel}
              className="w-full bg-primary-dark hover:bg-primary text-white font-medium py-3 rounded-xl text-sm min-h-11"
            >
              完成
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
