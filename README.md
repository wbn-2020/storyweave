# 织章 · StoryWeave

AI 小说创作工作台：把故事结构、正文与设定放在同一个可持续修改的创作空间。

## 查看设计

- [可点击 UI 原型](prototype/index.html)
- [模块、业务流程与数据流](prototype/flows.html)
- [产品设计与范围](docs/01-product.md)
- [界面与交互设计](docs/02-ui.md)
- [流程图源稿](docs/03-flows.md)
- [同类产品与开源调研](docs/04-research.md)
- [后续开发边界](docs/05-development.md)
- [验证记录](docs/06-validation.md)

可直接用浏览器打开 `prototype/index.html`。若希望通过本地地址查看，在父目录运行：

```bash
node ../design-tools/serve.mjs
```

默认入口为 `http://127.0.0.1:8765/storyweave/prototype/`；若端口已占用，可用 `--port 8766`。服务只监听本机地址。

## 当前交付

这是设计基线与交互原型。示例故事、人物、正文和 AI 建议用于验证产品流程，不是已接入模型的生产系统。原型中的编辑数据仅保存在当前浏览器；正式版本需增加可靠的保存、备份与迁移机制。

产品工作名与目录名已经确定，尚未做商标或域名可用性核查。后续应用代码可在本目录内开发；`prototype/` 保留为独立设计参考，不作为正式工程的架构模板。
