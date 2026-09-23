"use client";

import { useState, useCallback, useEffect } from "react";
import { getBaseline, saveBaseline, clearBaseline, type PostureBaseline } from "@/lib/storage";
import type { BaselineProfile, BaselineStoreSnapshot } from "@/types/desktop";

function createDefaultName(timestamp: number): string {
  const date = new Date(timestamp);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `姿态基线 ${value("month")}-${value("day")} ${value("hour")}:${value("minute")}`;
}

export function useBaseline() {
  const [baseline, setBaseline] = useState<PostureBaseline | null>(null);
  const [profiles, setProfiles] = useState<BaselineProfile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [isDesktop, setIsDesktop] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [storageError, setStorageError] = useState<string | null>(null);

  const applySnapshot = useCallback((snapshot: BaselineStoreSnapshot) => {
    const activeProfile =
      snapshot.profiles.find((profile) => profile.id === snapshot.activeId) ?? null;
    setProfiles(snapshot.profiles);
    setActiveProfileId(activeProfile?.id ?? null);
    setConfigPath(snapshot.configPath);
    setBaseline(activeProfile?.baseline ?? null);
    setStorageError(null);
    if (activeProfile) saveBaseline(activeProfile.baseline);
    else clearBaseline();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const localBaseline = getBaseline();
    // Sync the initial React state with the external browser/desktop store.
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    setBaseline(localBaseline);
    const api = window.postureDesktop?.baselines;
    setIsDesktop(Boolean(api));

    if (!api) {
      setIsLoading(false);
      return;
    }

    void (async () => {
      try {
        let snapshot = await api.list();
        if (snapshot.profiles.length === 0 && localBaseline) {
          snapshot = await api.create("默认基线", localBaseline);
        }
        if (!cancelled) applySnapshot(snapshot);
      } catch (error) {
        if (!cancelled) {
          setStorageError(error instanceof Error ? error.message : "无法读取桌面校准文件");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applySnapshot]);

  const captureBaseline = useCallback(
    (data: Omit<PostureBaseline, "capturedAt">) => {
      const entry: PostureBaseline = { ...data, capturedAt: Date.now() };
      saveBaseline(entry);
      setBaseline(entry);
      const api = window.postureDesktop?.baselines;
      if (api) {
        void api
          .create(createDefaultName(entry.capturedAt), entry)
          .then(applySnapshot)
          .catch((error) => {
            setStorageError(error instanceof Error ? error.message : "无法保存桌面校准文件");
          });
      }
      return entry;
    },
    [applySnapshot]
  );

  const removeBaseline = useCallback(() => {
    const api = window.postureDesktop?.baselines;
    if (api && activeProfileId) {
      return api
        .remove(activeProfileId)
        .then(applySnapshot)
        .catch((error) => {
          setStorageError(error instanceof Error ? error.message : "无法删除桌面校准文件");
        });
    }
    clearBaseline();
    setBaseline(null);
    return Promise.resolve();
  }, [activeProfileId, applySnapshot]);

  const selectProfile = useCallback(
    async (id: string) => {
      const api = window.postureDesktop?.baselines;
      if (!api) return;
      try {
        applySnapshot(await api.select(id));
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : "无法启用该基线");
      }
    },
    [applySnapshot]
  );

  const renameProfile = useCallback(
    async (id: string, name: string) => {
      const api = window.postureDesktop?.baselines;
      if (!api) return;
      try {
        applySnapshot(await api.rename(id, name));
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : "无法重命名该基线");
      }
    },
    [applySnapshot]
  );

  const deleteProfile = useCallback(
    async (id: string) => {
      const api = window.postureDesktop?.baselines;
      if (!api) return;
      try {
        applySnapshot(await api.remove(id));
      } catch (error) {
        setStorageError(error instanceof Error ? error.message : "无法删除该基线");
      }
    },
    [applySnapshot]
  );

  return {
    baseline,
    hasBaseline: baseline !== null,
    profiles,
    activeProfileId,
    configPath,
    isDesktop,
    isLoading,
    storageError,
    captureBaseline,
    removeBaseline,
    selectProfile,
    renameProfile,
    deleteProfile,
  };
}
