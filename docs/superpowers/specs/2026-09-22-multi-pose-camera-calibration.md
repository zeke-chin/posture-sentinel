# 2026-09-22 — 多姿势与摄像头视角校准

## 目标

把原先“面向摄像头保持 4 秒并取 4 个平均值”的单姿势校准，升级为完全本地、可重复的多姿势校准：

1. 估算人体正面与摄像头光轴的水平夹角；
2. 允许用户面向实际主显示器建立工作基线，而不是强制把摄像头方向当作零位；
3. 可选采集一个用户希望被提醒的常见姿势；
4. 只从差异显著且超过采样噪声的指标学习个人提醒边界；
5. 可选采集人体工学椅支撑下的舒适后仰，作为第二个良好姿势；
6. 本阶段不使用 AI 生成阈值。

## 校准流程

### 姿势一：摄像头零位（5 秒）

用户让身体和双肩正对摄像头。该姿势只用于建立摄像头坐标参考，不作为日常工作姿态标准。

采样质量要求：

- 能取得 MediaPipe `worldLandmarks`；
- 左右肩三维距离有效；
- 身体 yaw 与摄像头正面相差不超过约 25°；
- 至少取得 12 个有效样本。

### 姿势二：日常工作良好姿势（15 秒）

用户转回平时工作的主显示器，保持舒适、自然的良好坐姿。该姿势的中位数作为个人工作基线。

至少取得 36 个有效样本。实际检测链路把 React 状态更新限制在约 8 Hz，因此正常情况下可得到约 100 个样本。

### 姿势三：舒适后仰（10 秒，可跳过）

用户保持工作朝向，让整个背部贴住椅背，头部自然靠近颈托，并保持头颈随躯干一起后仰。该姿势是第二个良好姿势，不是休息或不良姿势。

采样要求：

- 必须取得肩部和髋部世界坐标；
- 能取得有效的躯干三维角度；
- 相对日常工作姿势最多增加 35° 后仰，避免把极端动作保存为良好姿势；没有最小后仰角要求；
- 至少取得 24 个有效样本。

用户不使用椅背或摄像头看不到髋部时可以跳过，评分行为保持原样。

### 姿势四：提醒姿势（8 秒，可跳过）

用户自然做出最常见、希望系统提醒的轻微含胸或低头姿势。不得要求用户做极端或引起不适的动作。

它不是医学意义的“坏姿势标准”，只是一组个人提醒示例。至少取得 18 个有效样本。

## 摄像头夹角算法

MediaPipe Pose Landmarker 返回以髋部中点为原点的三维 `worldLandmarks`。分别用双肩轴和双髋轴在摄像头 X-Z 平面的投影估算身体 yaw：

```text
shoulderYaw = atan2(leftShoulder.z - rightShoulder.z,
                    leftShoulder.x - rightShoulder.x)

hipYaw = atan2(leftHip.z - rightHip.z,
               leftHip.x - rightHip.x)
```

肩/髋连线属于“轴”而不是有向箭头，因此角度按 180°周期归一化到 `[-90°, 90°]`。两者一致时使用双角圆均值合并；差异超过 30°时只使用肩轴，避免被遮挡的髋部污染结果。

最终摄像头夹角为：

```text
cameraYaw = workingPose.bodyYaw - cameraFacingPose.bodyYaw
```

同样按 180°周期归一化。界面显示绝对值，保留带符号值供未来判断左右方向。

视角分类：

| 夹角绝对值 | 模式 |
| --- | --- |
| `< 20°` | 正面 `front` |
| `20°–65°` | 斜侧面 `oblique` |
| `≥ 65°` | 侧面 `side` |

该结果是单目模型估算值，产品只显示整数“约 N°”，不宣传为测量仪器级精度。

## 躯干后仰角算法

前后后仰不能继续使用画面二维肩髋连线判断。对于侧置约 45° 的摄像头，真实的前后移动会投影成画面左右移动，容易被旧指标误认为侧倾。

新算法使用世界坐标建立身体局部坐标系：

```text
across  = normalize(leftShoulder - rightShoulder) in X-Z plane
forward = rotate(across, -90°)
torso   = shoulderMid - hipMid

forwardDisplacement = dot(torso.xz, forward)
forwardLean = atan2(forwardDisplacement, hipMid.y - shoulderMid.y)
torsoRecline = -forwardLean
```

结果约定正数为后仰、负数为前倾。由于前后方向由身体自身的肩轴建立，而不是直接采用摄像头 Z 轴，因此人在正面、斜侧面或侧面朝向下使用同一计算方式。

MediaPipe 世界坐标是单目模型估算值，所以这里保存的是个人姿势中心及波动范围，不把角度宣传为医学或测量仪器结果。

人体工学范围只用作产品护栏，不代替个人校准：OSHA 把躯干与大腿约 105°–120° 的后仰列为中立工作姿势之一；UCLA 的工作站指南建议常见椅背角约 100°–110°。两者都强调背部支撑、头颈对齐和姿势变化，而不是要求所有人固定在一个角度。因此产品允许用户采集自己的舒适后仰中心，不设置最小后仰角，只保留相对工作姿势最多增加 35° 的极端动作保护。

参考资料：

- [OSHA Computer Workstations — Good Working Positions](https://www.osha.gov/etools/computer-workstations/positions)
- [OSHA Computer Workstations — Evaluation Checklist](https://www.osha.gov/etools/computer-workstations/checklists/evaluation)
- [UCLA Ergonomics — Postural Guide](https://ergonomics.ucla.edu/office-ergonomics/postural-guide)
- [MediaPipe Pose Landmarker Web API](https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker/web_js)

## 稳健统计

姿势中心不使用算术平均值，而使用中位数。每个指标同时保存 MAD（中位绝对偏差），yaw 使用考虑 180°周期的轴向 MAD。

校准可信度综合考虑：

- 有效样本数；
- 工作姿势与摄像头零位的 yaw MAD；
- 肩轴和髋轴估算的一致程度。

## 多个良好姿势如何进入评分

存在舒适后仰样本时，实时检测会比较当前姿势与两个良好姿势中心的归一化距离：

```text
distance = mean([
  ((headTilt - reference.headTilt) / 10°)²,
  ((shoulderTilt - reference.shoulderTilt) / 8°)²,
  ((neckForward - reference.neckForward) / 15)²,
  ((spineTilt - reference.spineTilt) / 6°)²,
  ((torsoRecline - reference.torsoRecline) / 10°)²  // 两边都有该值时加入
])
```

距离较近者成为当前评分参考。这样即使两个姿势的后仰角相差不足 5°，头、肩、颈或二维投影指标的稳定差异仍可用于选择正确基线；当后仰角不可用时也能退化为四项原有指标。所有指标都与同一组良好姿势聚合值比较，避免混用不同姿势的头、肩和躯干基线。

提醒姿势是在直立工作姿势下采集的，因此学习得到的“从良好走向提醒”的方向只在 `working` 模式使用。当前姿势匹配 `reclined` 时，改为相对舒适后仰基线使用容差评分，防止提醒样本把良好后仰误判为异常。

无法取得世界坐标、旧校准没有后仰字段或用户跳过第三段时，一律回退到 `working`，保持向后兼容。

## 提醒姿势如何进入评分

支持学习的指标：

- `headTilt`
- `shoulderTilt`
- `neckForward`
- `spineTilt`

只有同时满足以下条件的指标才进入 `learnedMetrics`：

```text
abs(reminderMedian - workingMedian)
  >= max(指标最小有效差异, 3 × max(workingMAD, reminderMAD))
```

当前最小有效差异：

| 指标 | 最小差异 |
| --- | ---: |
| 头部倾斜 | 3° |
| 肩膀倾斜 | 2° |
| 颈部前倾严重度 | 8 分 |
| 脊柱倾斜 | 3° |

对于可学习指标，实时值会映射到“从良好示例走向提醒示例”的进度。35%以内仍视为良好，85%达到示范姿势的高风险端。现有 overall score 与状态门槛继续生效。

未通过差异检查或跳过第三段的指标，按工作基线偏差评分：

| 指标 | warning 容差 | bad 容差 |
| --- | ---: | ---: |
| 头部倾斜 | 10° | 20° |
| 肩膀倾斜 | 8° | 15° |
| 颈部前倾严重度 | 15 分 | 35 分 |
| 脊柱倾斜 | 6° | 12° |

旧版单姿势 baseline 没有 `calibration` 字段，继续走原有算法，保持向后兼容。

## 存储结构

仍使用 `posture-sentinel:baseline`，顶层四个旧字段保留为工作姿势中位数。新增可选的 `calibration`：

```ts
interface PostureBaseline {
  headTilt: number;
  shoulderTilt: number;
  neckForward: number;
  spineTilt: number;
  capturedAt: number;
  calibration?: {
    schemaVersion: 2 | 3 | 4;
    cameraFacing: CalibrationPoseSummary;
    working: CalibrationPoseSummary;
    reclined?: CalibrationPoseSummary | null;
    reminder: CalibrationPoseSummary | null;
    learnedMetrics: CalibrationMetricKey[];
    cameraYaw: number;
    cameraYawMagnitude: number;
    viewMode: "front" | "oblique" | "side";
    confidence: "low" | "medium" | "high";
  };
}
```

现有全量导入/导出会自然携带嵌套结构，不改变外层导出信封版本。

schema v4 开始，头部倾斜和肩膀倾斜优先使用 MediaPipe 世界坐标计算。耳轴或肩轴相对水平面的角度为：

```text
tilt3d = atan2(abs(left.y - right.y),
               hypot(left.x - right.x, left.z - right.z))
```

该角度不受人体相对摄像头 yaw 的二维透视投影影响。世界坐标不可用时回退到二维指标。schema v2/v3 的既有校准保存的是旧二维数值，因此继续使用旧算法参与评分；重新校准后写入 v4 并启用三维头肩角，避免新旧坐标体系直接比较。

## 实时指标展示

存在个人校准时，指标卡主数字显示当前值相对所匹配良好姿势中心的绝对偏差，副文案保留原始值，并注明当前参考是“日常工作”还是“舒适后仰”。卡片颜色和进度条直接使用评分引擎返回的子项分数：

| 子项分数 | 展示状态 |
| ---: | --- |
| `>= 80` | 良好（绿色） |
| `50–79` | 注意（黄色） |
| `< 50` | 不良（红色） |

这样卡片颜色、总评分和整体状态使用同一套个人化判断，不再用固定原始角度阈值单独着色。摄像头覆盖层的头部角度标签同样显示个人化偏差，并按头部子项分数着色。

## 隐私

- 不录制、不截图、不上传视频；
- 原始逐帧关键点只存在于校准组件内存中；
- localStorage 只保存各姿势的聚合中位数、MAD、样本数和夹角；
- 不向 AI 或 `/api/advice` 发送校准数据。

## 开发环境诊断日志

非生产环境在浏览器控制台输出以 `[姿态校准]` 开头的结构化日志。生产构建不会输出这些校准诊断。

舒适后仰阶段最多约每秒输出一次当前状态，字段包括：

- `result`：`accepted` 或具体拒绝原因；
- `worldLandmarkCount`：世界坐标关键点数量；
- `shouldersValid` / `hipsValid`：肩部和髋部关键点是否为有限数值；
- `shoulderAxisLength`：X-Z 平面的肩轴长度；
- `torsoVerticalLength`：肩髋垂直距离；
- `bodyYaw`：当前身体朝向；
- `workingRecline`：第二步的工作姿势后仰中心；
- `currentRecline`：当前帧后仰角；
- `reclineDelta`：当前帧相对工作姿势增加的后仰角。

阶段结束时输出有效样本数、最低样本要求和各拒绝原因累计次数。常见拒绝原因：

| `result` | 含义 |
| --- | --- |
| `world-landmarks-unavailable` | 模型没有返回世界坐标 |
| `body-yaw-unavailable` | 双肩方向轴无法建立 |
| `torso-recline-unavailable` | 肩部或髋部缺失，或肩轴/肩髋距离过短 |
| `recline-delta-too-large` | 相对第二步后仰超过 35° |

日志只包含局部几何诊断和聚合计数，不打印完整关键点数组、视频帧或图像。

## 已知限制

1. MediaPipe world landmarks 是单目模型估计，不是深度相机测量；衣物、遮挡和模型训练分布都会带来误差。
2. 当前夹角代表躯干相对摄像头的 yaw，不等于头部相对躯干的颈部旋转。后者需要单独的头部姿态模型或 Face Landmarker。
3. schema v4 已把头部和肩膀倾斜改为世界坐标三维角；颈部前倾和躯干侧倾仍包含二维图像指标，尚未全部重写为身体坐标系下的三维解剖角。
4. 摄像头或座位明显移动后应重新校准。未来可用实时 body yaw 与保存的 working yaw 做漂移提醒。
5. 系统可以识别“与已采集舒适后仰相似”，但摄像头无法确认椅背或颈托是否真正承重，也无法直接测量腰椎曲线。因此产品不声称诊断椅背支撑质量。

## 手动验收

1. 正对摄像头完成第一段，转向约 45°的主显示器完成第二段，结果应显示“斜侧面、约 45°”。
2. 在第三段从日常工作姿势整体后仰约 15°–25°，结果应保存舒适后仰角；检测时在该姿势和直立姿势之间切换，两者都不应仅因切换而告警。
3. 第三段后仰不足 5° 时仍应正常采集；只要其他姿态指标存在稳定差异，实时检测仍应能选择较近的良好姿势。
4. 第四段仅低头，`learnedMetrics` 应主要包含 `neckForward` 或 `spineTilt`，不应无条件学习全部指标。
5. 跳过舒适后仰和提醒姿势仍可保存校准，行为与旧流程一致。
6. 遮住肩膀或离开画面时应因有效样本不足而要求重试，不应保存全零数据。
7. 旧 baseline 与 schema v2 profile 仍可加载和参与评分；重新校准后设置页显示夹角、视角、舒适后仰和可信度。
8. 导出再导入数据后，嵌套的 `calibration` profile 保持完整。
9. 在正在检测的会话中重新校准时，analyzer 暂停累计和告警；关闭校准后恢复。原本已暂停的会话只临时启动关键点推理，关闭校准后仍保持暂停。

## Electron 桌面扩展

- 校准期间不使用覆盖摄像头的全屏蒙层。摄像头、骨架和 `REC · 校准` 保持可见，阶段说明、质量反馈、有效样本数与倒计时显示在摄像头右侧面板。
- Electron 使用受限 preload API 管理基线，渲染进程不直接获得 Node.js 或文件系统权限。
- 多个命名基线保存在 `~/.config/posture-sentinel/calibrations.json`。写入采用同目录临时文件后原子替换，目录权限为 `0700`，文件权限为 `0600`。
- 每次完成校准创建并启用一个新配置；数据管理页支持启用、重命名和删除。删除当前配置后自动启用剩余列表中的第一个配置。
- 当前启用的桌面基线同步到 `posture-sentinel:baseline`，保证评分、导入导出和浏览器版逻辑继续兼容；首次打开桌面版时会把已有 localStorage 基线迁移为“默认基线”。
- 浏览器模式没有文件系统能力，继续使用单个 localStorage 基线。
