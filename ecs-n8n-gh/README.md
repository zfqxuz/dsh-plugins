# dsh-ecs-n8n-gh

一个 DSH（DeepSeek Harness）插件：把常用的 **ECS SSH / n8n 工作流 / GitHub Actions** 操作注册为模型工具。

只依赖 Node 内置模块（`node:child_process` 等），通过 `ssh` / `scp` / `gh` 命令行工作。

## 工具

| 工具 | 作用 |
|---|---|
| `ecs_exec` | 在配置的 ECS 主机上执行 shell 命令（SSH），返回合并后的 stdout/stderr 与退出码 |
| `ecs_status` | 输出 ECS 主机名、`docker ps`、生产 compose 状态 |
| `ecs_upload` | 通过 SCP 上传本地文件到 ECS |
| `n8n_status` | 查看 n8n 容器状态、健康端点、最近日志、激活的工作流 |
| `n8n_deploy_workflow` | 上传并部署 n8n 工作流 JSON（默认 `n8n/workflows/module-import.json`），强制重建 n8n 容器以导入并发布 |
| `gh_run_list` | 列出配置仓库最近的 GitHub Actions 运行 |
| `gh_run_view` | 查看某次 GitHub Actions 运行；`log_failed=true` 返回失败步骤日志 |

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `ecsHost` | `''` | ECS 主机地址（必填） |
| `ecsUser` | `root` | SSH 用户 |
| `ecsPort` | `22` | SSH 端口 |
| `sshKey` | `''` | SSH 私钥路径（必填；插件会复制到临时目录并 `chmod 600`） |
| `deployDir` | `/opt/touhou-trpg` | ECS 上的部署目录 |
| `composeFile` | `docker-compose.prod.yml` | 生产 compose 文件名 |
| `n8nContainer` | `touhou-trpg-n8n` | n8n 容器名 |
| `workspace` | `''` | 本地工作区（n8n 工作流上传用） |
| `ghRepo` | `''` | GitHub 仓库（`owner/repo`） |
| `maxOutput` | `30000` | 单次工具输出字符上限 |

也可以用环境变量提供默认值：`ECS_HOST`、`ECS_USER`、`ECS_PORT`、`ECS_SSH_KEY`、`DEPLOY_DIR`、`DSH_PROJECT_ROOT`、`GH_REPO`。

## 安装

### 官方 profile 插件

```bash
dsh plugin --profile web add /path/to/dsh-plugins/ecs-n8n-gh
```

然后在 profile 的 `cordis.patch.yml`（用户层）里按 `id: ecs-n8n-gh` 覆盖 `config:`。

### home-level 本地插件

```bash
cd /path/to/dsh-plugins
./install.sh ecs-n8n-gh

# 覆盖默认值：
ECS_HOST=203.0.113.10 SSH_KEY=/home/me/.ssh/id_ed25519 GH_REPO=me/repo \
  DSH_HOME=~/.dsh ./install.sh ecs-n8n-gh
```
