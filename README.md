# dsh-wecom-notification

DSH 停下来等你的那一刻，立刻往你的**企业微信群**推一条消息：

| 时刻 | 消息标题 |
|---|---|
| 工具需要你授权（`approval/request`） | 需要授权 |
| Agent 向你提问（`user-questions/request`） | 等待你的回答 |
| 一轮任务结束（`agent/status` → `idle`） | 任务已完成，等待下一步 |
| 目标被阻塞（`goal/changed`，`operation: block`） | 目标被阻塞 |
| 执行出错（`agent/error`） | 执行出错 |

消息格式是企业微信的 `markdown` 消息：

```text
**任务已完成，等待下一步**
<Agent 最后一条回复，最多 600 字>

📁 my-app  ·  💬 重构登录模块
```

授权消息会带上这次要执行的内容（例如 bash 的命令、要写的文件路径），在手机上就能看出是在批准什么：

```text
**需要授权**
需要授权执行 bash

允许本次操作使用 danger-full-access 权限：清理构建产物

`rm -rf build`

📁 my-app  ·  💬 重构登录模块
```

授权、提问、目标阻塞、出错都是触发即推送；「任务已完成」只在 DSH 真的停下来等你时才推送：

- Agent 空闲后要**保持空闲约 2 秒**才发——目标（goal）的下一轮、排队的追加消息、子 Agent 的结果会立刻把它重新唤醒，这些都不算「等你」；
- **子 Agent** 结束或出错不推送（它的父 Agent 会接着处理）；
- 你自己点了**停止**的那一轮、以及已经推送过「执行出错」的那一轮，不再追加一条「任务已完成」。

除此之外没有调度、没有去重；发送失败只记日志，不会阻塞 DSH。整条消息控制在企业微信的 4096 字节上限以内（超长部分截断为 `…`）。

消息的语言（标题和正文）跟随 DSH 自己的「设置 → 通用 → 语言」选择，不需要单独配置——没有手动选过的话，跟随系统语言，中文环境用中文、其它用英文。

整个插件只有**一个**配置项：企业微信群的 Webhook 地址。

## 1. 打造自己的专属通知群，拿到 Webhook 地址

企业微信的「消息推送」（旧版本叫「群机器人」）只能加在**内部群**里，而建群至少要 3 个人。所以先拉人建群、再把别人移出去，就得到一个只有你自己的专属通知群：

1. **建群**：在企业微信（手机或电脑端）点右上角「**+**」→「**发起群聊**」，随便选 **2 位同事**，创建群聊。
2. **改个好认的群名**（可选）：比如「DSH 通知」。
3. **移除其他人**：打开群设置（右上角「**…**」）→ 群成员旁的「**－**」，把刚才拉进来的同事都移出群。现在群里只剩你自己，消息不会打扰别人。
4. **添加消息推送**：还是在群设置里，找到「**消息推送**」（旧版本为「**群机器人**」）→「**添加**」→「**新创建一个消息推送**」（或「新创建一个机器人」），起个名字，比如 `DSH`，完成创建。
5. **复制 Webhook 地址**：创建完成后页面会显示形如下面的地址，复制下来：

   ```text
   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ```

   之后也可以在群设置 →「消息推送」→ 点开这个推送 → 查看/复制地址。

> ⚠️ 这个地址等同于往群里发消息的钥匙，不要提交到公开仓库或发给别人。泄露后可以在同一个页面删除该推送并重新创建一个。
>
> 如果群设置里看不到「消息推送」/「群机器人」，通常是外部群（含微信用户的群不支持），或者企业管理员关闭了该功能。

## 2. 安装插件

插件已发布到 npm：[`dsh-wecom-notification`](https://www.npmjs.com/package/dsh-wecom-notification)。

在 DSH Desktop 或 `dsh web` 里：侧边栏「**插件**」→「**添加插件**」，填入包名 `dsh-wecom-notification` → 安装 → 启用。

或者命令行：

```sh
dsh plugin --profile <profile> add dsh-wecom-notification
```

要用本地源码开发调试，把包名换成本仓库的**绝对路径**（例如 `/Users/you/Workspace/dsh-wecom-notification`）即可。

插件没有构建步骤，源码即发布产物（`index.js` 是 Host 端，`client.js` 是 Web 页面上的配置表单，`icon.svg` 与 `locale/*.json` 是插件页上显示的图标、名称和简介）。

## 3. 填写 Webhook 地址

侧边栏「**插件**」→ 点开 **dsh-wecom-notification** → 在「企业微信群机器人 Webhook 地址」里粘贴第 1 步复制的地址 →「**保存**」。

保存后立即生效，不需要重启 DSH。清空地址再保存即关闭推送。

也可以直接写进 profile 的 `cordis.patch.yml`（效果相同，插件页面保存时写的就是这里）：

```yaml
- id: wecom-notification
  name: dsh-wecom-notification
  config:
    url: https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
```

## 排查

- **收不到消息**：先确认插件页面里地址已保存；再看 DSH 日志里 `[dsh-wecom-notification]` 开头的行。企业微信即使拒收也会回 `HTTP 200`，插件会把非 0 的 `errcode` 记为 `delivery failed`（例如 `93000` 表示 key 无效）。
- **频率限制**：企业微信每个消息推送每分钟最多 20 条，超出的会被拒收并出现在日志里。
- **收到重复的通知**：检查 profile 的 `cordis.patch.yml` 里是否还启用着别的通知插件（例如旧的 `dsh-webhook-notification`）指向同一个群。

## 开发

```sh
pnpm install       # 只装测试用的 @deepseek-ai/schemastery（运行时由 DSH 自带的那份提供）
pnpm run verify    # node --check 两个运行时文件 + node --test
```

发版流程见 [AGENTS.md](AGENTS.md#releasing)。
