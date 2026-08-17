# 行政部驾驶舱 · 项目备忘

## 架构（2026-08-16 定稿，现行）
- 双源分离：
  - 任务 / 车辆 / 签证 三表 = WorkBuddy 内置**资料库**云数据表（任务总表 `E810IQGqpV9dHEwsnuIsb7`、车辆信息 `IlIuElUzWtxAKPBMcGXpBg`、签证情况 `61g9FSYbQZreyiC1Praqai`）。
  - 签证表字段（用户业务版，2026-08-17 重建）：姓名/护照类型/护照有效期至/签证类型/签证签发日期/签证到期日/Iqama办理状态/最近一次飞签时间；「护照剩余天数」不建列（库无公式列），由看板前端按护照有效期至实时算。旧表 `x2YEbPkkxTfnCNOxA1EWdM` 已弃用。
  - 会议室预约 = **腾讯在线表格**（docs.qq.com/sheet/DUFNXTnBsV1pGYmZ4?tab=BB08J2）+ 腾讯文档连接器。
- 桥接 bridge/ 已废弃；现流程：`lib_sync.py` 每小时经资料库 API 拉三表 CSV → 与腾讯会议室 CSV 一并交 `static/build.js` 内联进静态页 → CloudStudio 重新部署（同一在线链接刷新）。
- 部门共享填报：资料库云表需在 WorkBuddy 内手动「共享/授权编辑」给部门成员（无程序化共享 API，属一次性 UI 操作）。

## 当前代码状态
- 线上/代码 = **v1.13.0**（commit `b68657c` 为资料库迁移；UI 主文件仍沿用名 `行政部驾驶舱_UI_v1.10.0.html` 未改名）。
- v1.11.0（移动端自适应 / 车辆看板精简 / 会议室部门显示）与 v1.12.0（分角色视角）已回退撤销，仅存 git 历史，需要时 `git cherry-pick` 恢复。

## 在线交付
- CloudStudio 链接：https://26e39b5a0aed44d7b0bfbb45dd2fd2c6.app.workbuddy.link（已验证）。
- 二级只读看板：`车辆管理.html` / `任务管理.html`，顶部「去资料库录入」按钮直达对应云表（部门共享填报）。
- 风格单一来源：`cockpit-style.css`；`static/build.js` 内联 CSS + `__COCKPIT_DATA__` 进 dist/static。

## 自动化（HOURLY, ACTIVE）
- `automation-1786812677644`：腾讯会议室表 → `bridge/drop/tencent/tencent_room.csv`（脚本 `_sync_tencent_room.py`：tdoc_call get_cell_data return_csv → 二次解析 jsonrpc → 取 csv_data 落盘；失败写 error.log 保旧文件）。
- `automation-1786823878843`：资料库三表 + 腾讯会议室 → drop → build.js → 部署（同链接刷新）。

## 会议室解析要点（腾讯表）
- 标题行「会议室预约登记表」+ 表头 序号/预约日期/时间段/预约人/部门/联系电话/参会人数/会议主题；无"会议室"列、无"状态"列。
- 双语表头含嵌入换行（如「预约日期\nDATE」「部门\nDepartment」），原样保留，解析在网页端（parseRooms）。
- 腾讯侧"真自动"正路 = 腾讯文档连接器 `tdoc_call sheet-mcp get_cell_data`（file_url + sheet_id=BB08J2, return_csv=true），纯静态网页不可直连。

## 主表「任务总表」字段
任务名称/所属大类/子项备注/负责人/协同人/状态/进度%/开始日期/截止日期/优先级/堵点说明/是否逾期(公式)/更新时间(公式)。

## 六大类 / 视图 / 仪表盘
- 六大类：会务接待、车辆管理、后勤管理、物资采购、行政办公、人力资源（预留"其他"）。
- 视图：看板(按负责人)、看板(按状态)、日历、领导视图（筛选未完成 + 隐藏细节）。
- 仪表盘：总/进行中/已完成/逾期 卡 + 完成率进度环 + 各大类条形图。
- 进度表现：数字 + 进度条。

## 约束
- 敏感信息（工资/身份证/处分）不进表。
- 用户偏大白话，沟通与文档避免技术术语。
- 约 12 人使用，名单未定，负责人 = 文本列写人名，支持后期手动增减。
