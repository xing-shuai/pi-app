# 产品字号规范

在保留用户截图中的 Chat/Code 布局与窗口密度的前提下，二级页面不再沿用旧的 10–13px UI 字号。设计像素统一为：

| 用途 | 字号 / 行高 |
|---|---|
| 正文、导航、表单标签与输入 | 16px / 1.5 |
| 辅助说明、描述、验证信息 | 14px / 1.6 |
| 状态、徽标、微型元数据 | 12px 起 / 1.5 |
| 页面标题 | 24px / 1.5 |
| 分节标题 | 18px / 1.5 |
| 代码、路径编辑器与日志 | 14px 等宽 / 1.6，数值输入可保持 16px 等宽 |

覆盖 Settings 的导航、页面标题、行标签/描述、表单、搜索、子面板、保存栏及设置弹窗，也覆盖 Routines、SSH 连接表单/密码框/控制台。模型与思考选择器同步使用该层级，不再混用 9 / 10.5 / 12.5px 等小字号。顶部嵌入式设置栏标题为 16px、返回文字为 14px。

实现入口：`src/renderer/src/styles/product-typography.css` 与 Settings 共享 primitives。兼容映射只在指定二级界面/设置弹窗内生效，不全局放大所有 p/span/button，也不改变参考主页、图标、布局宽度或缩放设置。

注意本项目的旧 Tailwind 尺度里 `text-base` 实际为 13px、`text-sm` 为 12px，不能按标准 Tailwind 默认值理解。新页面优先使用共享 primitives/语义字号，而不是继续叠加微型字号类。

按最新反馈，UI、Chat 问候/回复和 Code 信息流统一使用 `var(--font-sans)`；不再为聊天正文强制 serif。代码、路径、终端仍使用 monospace。Chat/Code 正文为 16px / 1.6–1.65，辅助文字保持 14px，代码 14px 等宽。Chat 局部样式在 `features/chat/chat-refinements.css`，Code 信息流样式单独限定参考工作台，避免破坏其他页面。用户屏幕 DPR 1.5、UI 密度 5/6 时，16 设计 px 对应约 20 物理 px。

验证包括 headless Chrome 的实际 computed-style 测量，以及 Electron 中在真实对应密度下比较首页和 Settings 导航的字号、字体，检查标题/说明层级并输出截图。
