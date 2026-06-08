# 隔夜持股公开版

这是从本地 `overnight-holding` skill 的 `state.json` 生成的静态公开站。

- 托管目标：GitHub Pages
- 数据来源：本地 skill 快照
- 运行形态：纯 HTML/CSS/JS，无服务端、无登录、无付费资源

## 自动更新

仓库内置 GitHub Actions 免费定时任务：

- 交易日北京时间 14:45 自动运行一次。
- 运行顺序与本地 `overnight-holding` skill 保持一致：先验证上一个持仓日，再按胜率调整参数，最后扫描最新交易日。
- 如果目标交易日已经有持仓快照，任务只补齐验证明细，不重复覆盖当天名单。
- 如果行情接口临时失败，网页会继续展示上一版已提交快照。

需要立刻刷新时，可以在 GitHub 仓库的 Actions 页面手动运行 `Update overnight holding snapshot`。
