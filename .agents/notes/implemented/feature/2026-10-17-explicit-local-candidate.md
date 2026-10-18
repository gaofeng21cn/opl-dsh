# Agent Note: 显式本地候选安装

Status: implemented

## Problem

干净分支构建出的未合并候选包被当作普通发布版本，启动时自动更新到不含候选改动的官方版本。

## Decision

安装器接受 `--local-candidate` 并持久记录本地候选身份。已有更新流程读取此标记，保留当前增强包；脏源码产物继续自动标为候选。

## Alternatives considered

不靠修改源码制造脏产物来阻止更新，也不关闭正常发布安装的更新功能。

## Consequences

干净构建也可明确保持候选版本。恢复不带该参数的普通发布安装后恢复常规更新。
