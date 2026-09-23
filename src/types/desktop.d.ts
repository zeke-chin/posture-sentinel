import type { PostureBaseline } from "@/lib/storage";

export interface BaselineProfile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  baseline: PostureBaseline;
}

export interface BaselineStoreSnapshot {
  version: 1;
  activeId: string | null;
  profiles: BaselineProfile[];
  configPath: string;
}

interface DesktopBaselineApi {
  list: () => Promise<BaselineStoreSnapshot>;
  create: (name: string, baseline: PostureBaseline) => Promise<BaselineStoreSnapshot>;
  select: (id: string) => Promise<BaselineStoreSnapshot>;
  rename: (id: string, name: string) => Promise<BaselineStoreSnapshot>;
  remove: (id: string) => Promise<BaselineStoreSnapshot>;
}

interface DesktopMonitoringApi {
  keepsRunningWhenHidden: boolean;
  setActive: (active: boolean) => void;
  navigate: (path: string) => Promise<boolean>;
  syncRoute: (path: string) => void;
}

declare global {
  interface Window {
    postureDesktop?: {
      baselines: DesktopBaselineApi;
      monitoring: DesktopMonitoringApi;
    };
  }
}
