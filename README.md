# WPS 表单自动打卡

用无头 Chrome（CDP）自动完成 WPS 表单的定位打卡：**每次运行都从表单接口实时读取打卡围栏**，自动计算围栏中心并处理 WGS84 / GCJ-02 偏移，支持登录态自动续期、定时任务和状态告警。零第三方依赖（Node 内置 `fetch` / `WebSocket`）。

> 仅用于本人合法签到。请遵守学校/单位对打卡工具的规定，滥用风险自负。

## 特性

- **自动定位**：调用表单 `campaign/<shareId>/ranges` 接口取围栏多边形，鞋带公式算面积重心，不依赖手写经纬度
- **坐标系修正**：页面按 WGS84 读取浏览器定位再转 GCJ-02 比对，脚本把 GCJ-02 围栏中心反算回 WGS84 后注入，避免 500m 级偏移
- **登录态续期**：借助 `account.wps.cn` 的 kso 会话自动换新 `wps_sid` 并回写 cookie 文件
- **幂等**：页面提示「无法继续打卡」或输入框只读时直接判定本轮已完成，退出码 0
- **定时任务**：`--install-cron` 按配置的时间（默认周四 18:52 / 19:20）写入 crontab，每 6 小时保活
- **失败通知**：可选 webhook；同时保留日志与失败截图

## 环境要求

- Node.js >= 22（依赖内置 WebSocket）
- Chromium / Chrome（无头即可）
  - Debian/Ubuntu：`sudo apt-get install -y chromium`
  - 或用 `CHROME_PATH=/path/to/chrome` 指定

## 快速开始

```bash
git clone https://github.com/lin-hongkuan/wps-form-checkin.git
cd wps-form-checkin
cp config.example.json wps-checkin-config.json
# 编辑 wps-checkin-config.json：填 formUrl / name / studentId
```

1. 在浏览器登录 `f.wps.cn`，从 DevTools 复制完整 Cookie，导入：

```bash
node wps-checkin.mjs --import-cookie "wps_sid=...; kso_sid=...; uid=..."
# 或
node wps-checkin.mjs --import-cookie-file cookie.txt
```

2. 先确认围栏解析（不启动浏览器）：

```bash
node wps-checkin.mjs --locate
# 输出围栏名称、GCJ-02 中心、实际注入的 WGS84 坐标
```

3. 演练：填表 + 定位，但不提交：

```bash
node wps-checkin.mjs --dry-run
```

日志中定位地址应落在围栏对应的地点，且页面无「不在打卡范围内」提示。确认后再正式运行：

```bash
node wps-checkin.mjs
```

4. 安装定时任务（可选）：

```bash
node wps-checkin.mjs --print-cron      # 预览
node wps-checkin.mjs --install-cron    # 写入 crontab
node wps-checkin.mjs --uninstall-cron  # 移除
```

## 配置

`wps-checkin-config.json`（**不要提交**，已加入 `.gitignore`）：

```json
{
  "formUrl": "https://f.wps.cn/ksform/cw/w/XXXXXXXX",
  "name": "张三",
  "studentId": "2023000000",
  "autoLocation": true,
  "rangeName": "",
  "latitude": null,
  "longitude": null,
  "accuracy": 30,
  "schedule": {
    "weekday": 4,
    "times": ["18:52", "19:20"],
    "keepaliveEveryHours": 6
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `formUrl` | 打卡表单链接（必填） |
| `name` / `studentId` | 打卡人信息（必填） |
| `autoLocation` | 是否每次自动解析围栏，默认 `true` |
| `rangeName` | 存在多个围栏时按名称子串选择，留空取第一个 |
| `latitude` / `longitude` | 兜底坐标（WGS84）；`autoLocation=false` 时使用 |
| `accuracy` | 注入的定位精度（米），默认 30 |
| `schedule.weekday` | 打卡日，`0=周日`，默认 4（周四） |
| `schedule.times` | 中国时区的打卡时刻，可多个 |
| `schedule.keepaliveEveryHours` | 保活间隔小时数 |

环境变量会覆盖配置：`WPS_FORM_URL`、`WPS_NAME`、`WPS_STUDENT_ID`、`WPS_RANGE_NAME`、`WPS_AUTO_LOCATION=0`、`WPS_LAT` / `WPS_LNG`。

## 工作原理

1. 从 `formUrl` 解析 `shareId`，`POST https://f-api.wps.cn/ksform/api/v3/campaign/<shareId>/ranges`
2. 取围栏多边形顶点（GCJ-02），用鞋带公式求面积重心
3. GCJ-02 → WGS84 迭代反算（页面会再做一次 WGS84 → GCJ-02）
4. CDP `Page.addScriptToEvaluateOnNewDocument` 覆写 `navigator.geolocation`，并设置 `Emulation.setGeolocationOverride`
5. 校验/续期 WPS 登录态 → 打开表单 → 填姓名、学号 → 点击自动定位 → 提交
6. 轮询页面确认「打卡成功」，再次打开表单复核「无法继续打卡」记录

坐标系说明：围栏接口返回 `coordType=gcj02`；浏览器 `navigator.geolocation` 按 WGS84 语义使用，页面在比对前会转换。如果目标页面不做转换，可关闭自动定位并直接填写围栏中心（`WPS_AUTO_LOCATION=0` + `WPS_LAT/WPS_LNG`）。

## 命令与退出码

| 命令 | 作用 |
| --- | --- |
| 无参数 | 立即打卡，已打卡自动跳过 |
| `--status` | 只检查本轮是否已打卡 |
| `--keepalive` | 保活 / 续期登录态 |
| `--dry-run` | 填表定位，不提交 |
| `--locate` | 只解析围栏并输出坐标 |
| `--import-cookie` / `--import-cookie-file` | 导入登录态 |
| `--install-cron` / `--print-cron` / `--uninstall-cron` | 管理定时任务 |

退出码：`0` 成功/已打卡，`1` 失败，`2` 环境/配置错误，`3` 未打卡，`4` 登录态失效。

## 安全与隐私

以下文件已在 `.gitignore` 中排除，请勿提交或外传：

- `wps-checkin-cookies.json`：登录凭证（含长期续期 token）
- `wps-checkin-config.json`：表单链接与个人信息
- `wps-checkin.log`、`wps-checkin-*.png`：运行日志与页面截图

Cookie 文件建议 `chmod 600`。

## 已知限制

- 自动定位仅支持**多边形围栏**；圆形/点位围栏会退回兜底坐标
- 表单若限制「仅手机打开」，脚本已内置 iPhone UA 与移动视口
- 仅支持「一次/周期」类打卡表单，不处理多题问卷

## License

MIT