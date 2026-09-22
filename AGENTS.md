# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.


本项目用的是 Next.js **16.2.9**,其 API 与多数训练数据不一致。`node_modules/next/dist/docs/` 内是版本匹配的官方文档(`01-app/02-guides/upgrading/version-16.md` 是破坏性变更清单)。写框架代码前先读对应章节。本项目相关的 v16 关键变更:`middleware.ts` → `proxy.ts`;`params` / `searchParams` / `cookies` / `headers` 只能异步访问;Turbopack 成为默认打包器;`next lint` 已移除且 **`next build` 不再执行 lint**(因此本仓库改用独立 linter 不影响构建)。

## 常用命令

包管理器为 **bun**(`bun.lock` 已入库,不再使用 npm / `package-lock.json`)。

```bash
bun install
bun run dev          # next dev(Turbopack),http://localhost:3000
bun run build
bun run start
bun run lint         # oxlint
bun run lint:fix     # oxlint --fix
bun run format       # oxfmt(写入)
bun run format:check # oxfmt --check
bun run typecheck    # tsc --noEmit
```

### Lint 与格式化:已从 ESLint 迁移到 oxlint + oxfmt

- **oxlint 1.85.0** — 替代 `eslint` + `eslint-config-next`,配置见 `.oxlintrc.json`。已确认它覆盖了原先由 `eslint-config-next` 提供的 React Compiler 规则(`set-state-in-effect`、`refs`、`purity`、`preserve-manual-memoization`),所以这次迁移没有丢失检查项。`perf` 类目**故意关闭**(`no-array-index-key` 等会在既有代码上刷出 20 条噪声);需要时可在 `.oxlintrc.json` 的 `categories` 中打开。
- **oxfmt 0.70.0** — 替代 Prettier,配置见 `.oxfmtrc.json`。注意它仍是 `0.x` 版本。
- `react/react-in-jsx-scope` 已关闭:项目使用新版 JSX transform(`tsconfig` 的 `"jsx": "react-jsx"`),该规则纯属误报。

**三个基线状态(改动前就已如此,不要误判为自己引入的回归):**

| 命令 | 基线 | 说明 |
| --- | --- | --- |
| `bun run typecheck` | ✅ 通过 | 可作为可靠门禁 |
| `bun run build` | ✅ 通过 | 可作为可靠门禁 |
| `bun run lint` | ❌ 55 errors / 23 warnings | 多为既有的 React Compiler 问题,集中在约 30 个文件 |
| `bun run format:check` | ❌ 87 / 109 文件需格式化 | 见下 |

`format:check` 失败是因为**仓库从未用 oxfmt 格式化过**(迁移时有意没有执行 `bun run format` —— 那会产生一个淹没其余改动的巨大 diff)。首次全量格式化请单独开一个提交完成,不要混在功能改动里。

lint 的错误集中在 `react-hooks/set-state-in-effect` 与"render 期间访问 ref"两类,是既有代码的真实问题,不要为了消除报错而做大规模重构。

### 测试:接手时没有,后续要补

**接手这个仓库时它没有任何测试框架**(无 vitest / jest / playwright,无 `test` 脚本)。验证只能靠 `bun run typecheck`、`bun run build` 和手动跑一遍摄像头流程。

**后续计划引入测试框架(如 vitest)**,并补上 `bun run test` 与单测脚本。在框架真正装上之前,不要在文档或代码里假定 `test` 脚本存在。优先值得补测的是纯函数层:`src/lib/posture.ts`(评分算法)、`src/lib/storage.ts`(读写与迁移)、`src/lib/report.ts`、`src/lib/achievements.ts` —— 这些不依赖摄像头和 DOM,最容易测。

### 环境变量

`DEEPSEEK_API_KEY` 是 AI 建议功能所必需(部署时配置在 Vercel 环境变量中;`.env*` 已被 gitignore)。未配置时 `/api/advice` 返回 503,日报页会渲染一条占位文案。

## 架构

一个**隐私优先、完全跑在客户端**的坐姿监测工具。服务端只有一个路由,其余全部在浏览器中执行。

### 渲染模型

每个路由页面都是客户端组件(`"use client"`)。仅有的服务端组件是 `src/app/layout.tsx`、`src/app/page.tsx`(营销首页),以及 `detect/`、`settings/`、`report/` 下的各 `layout.tsx` —— 这些 layout **只**用于导出路由级 `metadata`,`children` 原样透传。新增路由元信息写在这里,而不是页面里。

路由:`/`(营销页)、`/detect`、`/report`、`/achievements`、`/data`、`/settings`、`POST /api/advice`。

### 检测流水线

`src/app/detect/page.tsx` 是**组装根**,不只是视图 —— hook 之间的连接全部在这里完成。`src/hooks/` 下的各 hook 刻意保持相互独立,彼此不调用(整个目录内唯一的一处 import 是类型级的 `Settings` 引用)。

```
useCamera(getUserMedia 640x480)
  → usePoseDetection(MediaPipe PoseLandmarker,RAF 循环,state 节流到约 8Hz)
    → usePostureMetrics(useMemo → analyzePosture(),纯函数)
      → usePostureAnalyzer.updateMetrics()   ← 只暂存一个"待定"状态
        [usePostureAnalyzer 内部 1s 定时器:应用 statusDebounce、累计时长与评分、
         每 30s 记录一次 scoreHistory、判定 shouldAlert]
      → useAlertSystem.showAlert()  → AlertNotification + 提示音 + 系统通知
      → useDetectSession(墙钟计时)/ 停止时 saveSession()
```

`good/warning/bad` 三个百分比以 **analyzer 的检测时长**为准(而非墙钟),三者之和须约为 100%(`src/app/detect/page.tsx:198-202`);墙钟时长只用于展示和会话时间区间。

页面中几处刻意为之的耦合:
- **休息提醒 ↔ analyzer**:进入 `resting`/`triggered` 时暂停 analyzer,避免用户离座拉伸的时间被计为不良坐姿(`src/app/detect/page.tsx:112-133`)。
- **番茄钟休息 ↔ 检测**:休息阶段自动暂停检测,专注阶段仅在**是它自己暂停的**情况下才自动恢复(`pomodoroAutoPausedRef`)。
- **检测启动由 effect 驱动**,不在 resume 处理函数里直接调用 —— 见 `src/app/detect/page.tsx:259-263`。
- 各处理函数都做了重入/幂等保护(连按空格,或语音与点击同时触发)。

### 分析核心

`src/lib/posture.ts` —— `analyzePosture(landmarks, thresholds, baseline?)` 是唯一入口。MediaPipe 关键点索引:nose 0、ears 7/8、shoulders 11/12、hips 23/24。权重 `{head 0.30, shoulder 0.20, neck 0.30, spine 0.20}`,缺失耳/髋时重新归一化;整体 `status` 取**最差的**可用子项(`<50` 为 bad,`<80` 为 warning,否则 good)。

两处容易看错的行为:
- `hasValidLandmark` **刻意忽略 `visibility` 字段** —— `pose_landmarker_lite` 返回的 visibility 是 0 或 undefined。
- 脖子前倾子项硬编码为 `scoreFromBadness(neckForwardScore, 20, 60)`(`src/lib/posture.ts:247`),因此与另外三项不同,它**不响应**可配置阈值。

个人基线(经 `CalibrationWizard` → `BaselineSampling` 采集)会把阈值平移为 `基线 + 容差`。注意 `BaselineSampling` 持久化的 neckForward 是 **0-100 的严重度**,而 `analyzePosture` 需要的是垂直比例,两者之间的逆向映射在 `src/lib/posture.ts:112-118`。未采集基线时行为与默认值完全一致。

### 持久化(localStorage)

schema 全部集中在 `src/lib/storage.ts`(模块级 `sessionsCache`,每次写入即失效,读取返回副本;写入配额不足时按比例减半重试,最低保留 10 条会话)。键名如下:

| 键 | 内容 |
| --- | --- |
| `posture-sentinel-sessions` | `SessionRecord[]`(**注意是连字符**,与其余键不同) |
| `posture-sentinel-settings` | 设置对象;版本迁移由 `useSettings` 的 `migrateSettings` 负责(`SETTINGS_VERSION = 2`) |
| `posture-sentinel:baseline` | 个人基线 + `capturedAt` |
| `posture-sentinel:achievements` | `{id, unlockedAt}[]` |
| `posture-sentinel:rest-settings` | 休息提醒配置 |
| `posture-sentinel:calibrated` | 直接在 `detect/page.tsx` 里读写的裸 `localStorage` 标记 |
| `posture-sentinel:model-cache` | 存在 IndexedDB(非 localStorage),见下 |
| `posture-advice-<date>` | AI 建议的 24 小时缓存,由 `AIAdvice.tsx` 写入 |

**没有全局 schema 版本号**,迁移是按域各自处理的:`migrateSessionRecord` 在每次读取时重命名旧字段(`avgHeadAngle`→`avgHeadTilt` 等);导入/导出自带 `version: 1` 信封。清除全部应用数据需要删除所有以 `posture-sentinel:` **或** `posture-advice-` 开头的键(`settings/page.tsx:31`)。`cleanupOldSessions()` 在应用挂载时经 `StorageCleanup` 清理 30 天前的会话。

### 模型加载

`src/lib/model-loader.ts` 是三级策略:本地 `public/models/*.task` → IndexedDB blob 缓存(7 天 TTL,键 `posture-sentinel:model-cache`)→ Google CDN。`ModelPreloader` 在首页非阻塞地预热,使 `/detect` 打开即用。`usePoseDetection` 另有独立的 GPU → CPU 回退链路(经 `src/lib/mediapipe-config.ts` 的第二个 CDN),超时 45s。

### 隐私红线

这些是产品的核心承诺,已在 `README.md` 中写明,不要破坏:
- 摄像头画面**绝不**录制、截图或上传。摄像头链路上唯一的 canvas 是 `SkeletonOverlay`,它把关键点画在透明 canvas 上让 `<video>` 透出来(`SkeletonOverlay.tsx:78`)。`html2canvas`(在 `ExportButton.tsx` 中)是应用里唯一一处有意的截图行为,它只栅格化**日报卡片 DOM** 用于分享,完全不接触视频或关键点。
- 坐姿数据只留在 localStorage。
- 对外网络请求仅有两类:MediaPipe 模型/WASM 下载,以及 `POST /api/advice` —— 后者**只接收经过净化的聚合数值**,不含图像或任何身份信息。正因为这些值会被插值进 prompt,`/api/advice` 用 `sanitizeNumber`(`route.ts:21`)对每个字段做区间钳制;新增字段时请沿用这一模式。该路由另有按 IP 的限流(10 次/分钟)。

## 项目约束

`README.md` 记录了 `master` 曾被强制回退到 `2e21a49` 作为已知可用基线 —— 起因是后续「未检测到人体」相关修复引入了新的 UI 与状态回归。当前 HEAD 是在该基线之上的若干文档/营销提交。**做检测相关的行为改动前请先开分支**,不要直接提交到 `master`。

`docs/superpowers/specs/` 存放功能设计规格(休息提醒、基线采样、导入导出 + 成就)。改动这些功能前先查该处的预期行为;规格里的「不在本轮范围」列出了明确的非目标(不做后端同步、不做多用户 profile、不做深色模式、不做 i18n)。

界面为全中文,绿色(emerald)设计系统以 Tailwind v4 的 CSS-first token 形式定义在 `src/app/globals.css`(`@theme inline`)。请使用这些 token(`bg-bg`、`text-text-secondary`、`bg-primary-dark` 等)而不是 Tailwind 原始色板类 —— 带 `-text` 后缀的变体承载了刻意做的 WCAG AA 对比度修正。项目**没有** `tailwind.config.js`,主题改动一律写进 `globals.css`。
