# dsh-tool-fs-jailed

根目录受限的**只读**文件系统工具（read / glob / grep），给不受信任的只读会话用。

状态：2026-10-09 从 /home/zfq/dshbot/qq/plugins/dsh-tool-fs-jailed 原样收编进本仓。
当前**没有任何 DSH profile 引用它**（grep ~/.dsh 无命中），且 package.json 声明的
dsh.bundle.patch=./cordis.patch.yml 与 files 里列的 README.md 在本仓收编前并不存在。
接入 registry / 补 cordis.patch.yml / 写安装脚本，另行排期。
