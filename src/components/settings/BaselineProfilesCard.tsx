"use client";

import { useState } from "react";
import type { BaselineProfile } from "@/types/desktop";

interface BaselineProfilesCardProps {
  profiles: BaselineProfile[];
  activeProfileId: string | null;
  configPath: string | null;
  isLoading: boolean;
  error: string | null;
  onSelect: (id: string) => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

export default function BaselineProfilesCard({
  profiles,
  activeProfileId,
  configPath,
  isLoading,
  error,
  onSelect,
  onRename,
  onDelete,
}: BaselineProfilesCardProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const startEditing = (profile: BaselineProfile) => {
    setEditingId(profile.id);
    setEditingName(profile.name);
  };

  const saveName = async () => {
    if (!editingId || !editingName.trim()) return;
    await onRename(editingId, editingName);
    setEditingId(null);
  };

  const confirmDelete = async (profile: BaselineProfile) => {
    if (!window.confirm(`确定删除“${profile.name}”吗？此操作无法撤销。`)) return;
    await onDelete(profile.id);
    if (editingId === profile.id) setEditingId(null);
  };

  return (
    <div className="bg-surface rounded-2xl p-6 border border-border">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-5">
        <div>
          <h3 className="text-lg font-bold text-text-primary">已保存的姿态基线</h3>
          <p className="text-xs text-text-secondary mt-1">
            可以为不同座位或摄像头位置保存独立基线，并随时切换。
          </p>
        </div>
        <span className="self-start rounded-full bg-primary-light px-3 py-1 text-xs font-medium text-primary-text">
          {profiles.length} 个配置
        </span>
      </div>

      {configPath && (
        <div className="rounded-xl bg-surface-alt px-4 py-3 mb-4">
          <p className="text-xs text-text-muted mb-1">本地文件</p>
          <code className="block text-xs text-text-secondary break-all">{configPath}</code>
        </div>
      )}

      {error && (
        <p className="rounded-xl bg-danger-light px-4 py-3 text-sm text-danger-text mb-4">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-text-muted py-6 text-center">正在读取本地基线文件…</p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-text-muted py-6 text-center">
          还没有保存的基线，完成一次校准后会自动出现在这里。
        </p>
      ) : (
        <div className="space-y-3">
          {profiles.map((profile) => {
            const isActive = profile.id === activeProfileId;
            const isEditing = profile.id === editingId;
            return (
              <div
                key={profile.id}
                className={`rounded-xl border p-4 transition-colors ${
                  isActive ? "border-primary bg-primary-light/40" : "border-border bg-surface-alt"
                }`}
              >
                {isEditing ? (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveName();
                        if (event.key === "Escape") setEditingId(null);
                      }}
                      maxLength={60}
                      className="min-h-11 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-text-primary outline-none focus:border-primary"
                      aria-label="基线名称"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => void saveName()}
                        disabled={!editingName.trim()}
                        className="min-h-11 flex-1 sm:flex-none rounded-lg bg-primary-dark px-4 text-sm font-medium text-white disabled:opacity-50"
                      >
                        保存
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="min-h-11 flex-1 sm:flex-none rounded-lg border border-border px-4 text-sm font-medium text-text-secondary"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <button
                      onClick={() => void onSelect(profile.id)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                      aria-label={`启用${profile.name}`}
                    >
                      <span
                        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                          isActive ? "border-primary" : "border-border"
                        }`}
                      >
                        {isActive && <span className="h-2.5 w-2.5 rounded-full bg-primary" />}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold text-text-primary">
                            {profile.name}
                          </span>
                          {isActive && (
                            <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-white">
                              当前使用
                            </span>
                          )}
                        </span>
                        <span className="block text-xs text-text-muted mt-1">
                          校准于 {formatDateTime(profile.baseline.capturedAt)}
                        </span>
                      </span>
                    </button>
                    <div className="flex gap-2 pl-8 sm:pl-0">
                      {!isActive && (
                        <button
                          onClick={() => void onSelect(profile.id)}
                          className="min-h-10 rounded-lg border border-primary/30 px-3 text-xs font-medium text-primary-text hover:bg-primary-light"
                        >
                          启用
                        </button>
                      )}
                      <button
                        onClick={() => startEditing(profile)}
                        className="min-h-10 rounded-lg border border-border px-3 text-xs font-medium text-text-secondary hover:bg-surface"
                      >
                        重命名
                      </button>
                      <button
                        onClick={() => void confirmDelete(profile)}
                        className="min-h-10 rounded-lg border border-danger/30 px-3 text-xs font-medium text-danger-text hover:bg-danger-light"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
