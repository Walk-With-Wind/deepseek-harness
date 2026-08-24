# Agent Note: 按已验证候选路径解析 Windows 发行索引

Status: implemented

[English](2026-08-25-desktop-windows-candidate-relative-paths.md) | 中文

## 问题

Electron Forge 会把 Windows Squirrel 发行族写入 `squirrel.windows/x64/` 等 maker 专属目录。桌面端更新元数据与 provenance 会保留相对于产物根目录的路径。候选验证器先通过清单校验嵌套 `RELEASES` 的字节与 hash，随后却另外尝试从候选根目录读取 `RELEASES`。因此，完整原生矩阵虽然通过构建验收，但在创建无签名 Preview 草稿前仍会失败。

## 决策

候选清单是 maker 产物位置的权威来源。完成路径、角色、字节和 provenance 验证后，发布读取器按角色定位唯一的 `update-index` 产物，并从已验证的相对路径读取内容。Preview 与签名发布共用同一个候选读取器，因此两条发布路径都能接受 Forge 的真实目录结构，无需搜索文件系统或压平产物。

## 验证

Preview 与签名发布 fixture 会保留 Windows Squirrel 目录层级。对应发布计划必须验证嵌套的安装器、nupkg 与 `RELEASES`，从无签名 Preview 资产中排除更新文件，并让签名 Windows 更新元数据指向带目标前缀和嵌套路径的 nupkg 资产名。

## 考虑过的替代方案

**在上传或下载时压平 Windows 产物。** 压平会改变签名与 hash 候选证据之外的文件名，还会在 workflow 中重复已有清单记录的路径转换。

**递归搜索名为 `RELEASES` 的文件。** 按文件名搜索会引入另一项产物身份来源，而且可能选中清单未记录的文件。清单角色已经证明唯一性，并把路径绑定到对应字节证据。

**只为无签名 Preview workflow 增加特例。** 共享的签名发布读取器也存在相同根路径假设。修复共享读取器可让两条发布路径统一遵循已验证候选格式。

## 后果

只要生成的清单、hash、provenance 与文件一致，maker 目录变化就不会阻止发布。发布流程仍会拒绝缺失、重复、路径不安全或字节不一致的更新索引。Release 资产名会保留候选相对路径片段，因此生成的 Windows `RELEASES` URL 会继续指向准确且不可变的 nupkg 资产。
