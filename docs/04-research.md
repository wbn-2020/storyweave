# 织章：同类产品与 GitHub 开源调研

核验日期：2026-11-03。方法：公开官网／帮助页面、仓库元数据、README 与许可原文的只读核对。没有下载、运行或部署第三方代码。官网效果宣传和README功能描述不等于实测结果。

## 1. 直接相关的小说工作台

| 参考 | 已核对主交互 | 可借鉴 | 许可与限制 |
|---|---|---|---|
| [Sudowrite](https://www.sudowrite.com/) | 商业创作工具；官网帮助资料描述Canvas、Story Bible和局部Quick Edit。调研记录显示Canvas与Story Bible之间通过复制转移，而非自动双向同步 | 结构构思与正文局部编辑分离，建议可接受／拒绝 | 商业服务，未发现源码复用授权；本轮未运行、不能据此保证当前全部交互 |
| [OpenWrite](https://github.com/ilrein/openwrite) | README明确“设定→幕→章→场景”的节点生成画布、自动布局、章节节点进入正文；另有Tiptap编辑器、设定Codex、版本冲突检测和Markdown导出 | 画布直接连接章节写作，比独立关系图更贴近任务 | [AGPL-3.0](https://github.com/ilrein/openwrite/blob/main/LICENSE.md)，不能默认可闭源改造；React／Cloudflare技术栈与拟采用Java后端不同 |
| [NovelForge](https://github.com/RhythmicWave/NovelForge) | 调研已核对的README描述卡片式长篇创作、结构化生成和上下文引用；正文建议可以逐条接受／拒绝 | 把人物、世界和章节作为可引用的创作资产，保留用户确认 | [AGPL-3.0](https://github.com/RhythmicWave/NovelForge/blob/main/LICENSE)。README已在调研中核对；后续补取遇到网络超时，未运行验证 |

### 源码与活跃度口径

- [OpenWrite README](https://github.com/ilrein/openwrite/blob/main/README.md)。[作者演示入口](https://openwrite.iliareingold.com)，本轮未运行演示。核验时 [GitHub pushed_at](https://api.github.com/repos/ilrein/openwrite) 为 **2026-08-19T00:53:02Z**。
- [NovelForge README](https://github.com/RhythmicWave/NovelForge/blob/main/README.md)。核验时 [GitHub pushed_at](https://api.github.com/repos/RhythmicWave/NovelForge) 为 **2026-09-23T04:58:53Z**。
- 最近推送是仓库元数据快照，不代表稳定版、质量或完整度。OpenWrite README将流式回复、自动人物关联、DOCX／EPUB导出和协作列为计划，不能将它们算作已实现能力。

## 2. 画布与编辑器组件

| 组件 | 对本产品的适配 | 许可证据 | 采用建议 |
|---|---|---|---|
| [Vue Flow](https://github.com/bcakmakoglu/vue-flow)／[官网](https://vueflow.dev/) | Vue节点、连线与自定义节点，适合情节与引用关系 | [MIT许可原文](https://github.com/bcakmakoglu/vue-flow/blob/master/LICENSE)；npm包元数据也标MIT | 节点型故事画布优先候选；性能和操作需用真实样例验证 |
| [Excalidraw](https://github.com/excalidraw/excalidraw) | 自由白板、手绘表达；适合构思草图 | [MIT](https://github.com/excalidraw/excalidraw/blob/master/LICENSE) | 有自由绘图价值，但结构化情节语义与Vue集成需另设计，不直接替代节点模型 |
| [tldraw](https://github.com/tldraw/tldraw) | 完整画布SDK | [当前自定义许可](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) | 默认许可允许开发环境，限制生产环境；公开面向用户的演示可能落入生产定义。需要独立授权评估，不当作免费生产替代 |
| [Tiptap](https://github.com/ueberdosis/tiptap)／[官网](https://tiptap.dev/) | 章节富文本、结构化文档和扩展 | [开源仓库MIT](https://github.com/ueberdosis/tiptap/blob/main/LICENSE.md) | 正文编辑优先候选；Cloud／Pro能力与开源核心分开核对，不默认包含在MIT范围 |

正式采用前仍须锁定具体包版本并检查其许可证及依赖。组件许可不自动覆盖示例资产或全部扩展。本轮原型未装入这些组件，使用新写的零依赖HTML／CSS／JS。

## 3. 采用的产品判断

1. **画布为写作服务。**节点必须能进入章节、关联设定、定位来源。只展示人物关系不足以支撑长篇写作。
2. **正文为最终资产。**局部建议先进入提议区，再由作者确认；保持原文可编辑、版本可恢复。
3. **设定不是聊天摘要。**事实、来源、确认状态和版本分开保存，正文提取结果不自动成为事实。
4. **修改影响比无限生成更重要。**作者改一条设定后，系统应帮助判断需要回看哪些情节和章节。
5. **画布与细读分工。**大纲／画布组织结构；编辑器负责逐段写作。不把所有面板永久挤在同一屏。
6. **不承诺训练或作品收入。**用户的API调用即可启动；长篇质量通过创作与审阅逐步验证。

## 4. 有意保留的研究边界

- 当前记录能确认OpenWrite是高相关小说画布参考，但不能断言它就是用户记忆中的项目。
- 未完成全面市场普查或对所有开源项目进行安全、性能、部署测试。
- Sudowrite交互依据公开帮助调研记录；正式对照需重新体验当前版本。
- 许可证是一项采用条件，AGPL并非禁止商业使用；关键是复用／修改／网络提供时的相应义务。
- 品牌与工作名未做商标核验。

## 5. 后续优先验证

用一部自拟短篇或授权样例，观察从故事种子到三章正文的全过程：画布是否帮助规划、上下文是否透明、建议是否可控、修改是否能追溯。先验证工作方式，再扩充海量生成、协作或自动发布。
