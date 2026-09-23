"use client";

interface CalibrationGuideProps {
  isMonitoring: boolean;
  isStarting: boolean;
  onStart: () => void;
  onDismiss: () => void;
}

export default function CalibrationGuide({
  isMonitoring,
  isStarting,
  onStart,
  onDismiss,
}: CalibrationGuideProps) {
  return (
    <aside
      aria-labelledby="calibration-guide-title"
      className="mb-6 rounded-2xl border border-primary/30 bg-primary-light/50 p-5 shadow-sm md:p-6"
    >
      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
        <div className="max-w-2xl">
          <p className="mb-1 text-xs font-semibold tracking-wide text-primary-text">
            首次使用 · 建议校准
          </p>
          <h2 id="calibration-guide-title" className="text-lg font-bold text-text-primary">
            让提醒先认识你的自然坐姿
          </h2>
          <p className="mt-2 text-sm leading-relaxed text-text-secondary">
            校准会采集你的摄像头朝向和日常工作姿势，作为个人判断基线。不校准也能先监测，之后随时可以补做。
          </p>
          <ol className="mt-3 space-y-1 text-sm text-text-secondary">
            <li>1. 让头部、双肩，最好还有髋部出现在画面中。</li>
            <li>2. 短暂正对摄像头建立方向参考，再转回主屏幕自然坐好。</li>
            <li>3. 舒适后仰和希望提醒的姿势是可选步骤。</li>
          </ol>
          <p className="mt-3 text-xs text-text-muted">
            {isMonitoring && "校准期间会暂停坐姿计分，完成后继续监测。"}
            视频不会被录制或上传。
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2 lg:flex-col">
          <button
            type="button"
            onClick={onStart}
            disabled={isStarting}
            className="rounded-xl bg-primary-dark px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary disabled:cursor-wait disabled:opacity-60"
          >
            {isStarting ? "正在启动摄像头…" : "开始个人校准"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-alt"
          >
            稍后再说
          </button>
        </div>
      </div>
    </aside>
  );
}
