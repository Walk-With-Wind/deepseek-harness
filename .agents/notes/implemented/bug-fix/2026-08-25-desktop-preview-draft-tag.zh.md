# Agent Note: 在草稿验证后绑定 Preview tag

Status: implemented

[English](2026-08-25-desktop-preview-draft-tag.md) | 中文

## 问题

使用显式目标 commit 创建 GitHub draft Release 时，GitHub 会记录 `targetCommitish`，但不会实际创建对应的 Git tag 引用。Preview workflow 校验完草稿资产字节后，会在发布前要求该 tag 引用存在，因此完整草稿会停在最终发布步骤。状态解析器也只接受已发布且不可变的 Release，后续 run 无法验证并完成身份一致的草稿。

## 决策

Preview 状态会区分不存在的 Release、可变 draft 和已发布的不可变 prerelease。只有 prerelease 标志与目标 commit 都匹配冻结源时，draft 才可恢复。每次运行都会生成 Release notes，并让 workflow 比较完整远端资产集、标题、警告说明与本地计划。全部检查通过后，流程才会在冻结 commit 上创建缺失的轻量 tag，把任何已有 tag 对象递归解析到该 commit，再发布草稿。已发布 Release 仍必须同时满足 tag 目标精确一致和不可变状态。

## 验证

Workflow 测试会要求草稿与已发布状态分别输出、允许复用草稿、显式创建 Git 引用、精确绑定源 commit，并确保步骤顺序为草稿字节验证、tag 绑定、不可变发布。相同测试还要求仓库凭据只出现在调用 GitHub API 的步骤中。

## 考虑过的替代方案

**假设创建草稿时也会创建 tag。** GitHub 会在没有创建 `refs/tags/<name>` 的情况下暴露草稿目标 commit，因此该假设无法证明最终 tag 身份。

**在上传草稿前创建 tag。** 上传失败时会留下一个面向公开仓库的引用，但对应资产集从未通过字节验证。

**先发布，再检查自动生成的 tag。** 不可变发布会让错误 tag 目标或不完整公开记录无法修复。

**丢弃每个已有草稿。** 目标正确且字节完全一致的草稿在重复全部本地与远端检查后可以安全恢复。复用可避免再次上传大体积资产，且不会削弱验证。

## 后果

失败 run 可以留下私有草稿，而不会公开未经验证的 tag。后续受保护 run 只有在重新生成并匹配完整发布计划后，才能完成该草稿。tag 会在发布前最后一个可逆节点创建；已发布 tag、目标 commit、资产、标题、说明、prerelease 状态与不可变性仍会分别验证。
