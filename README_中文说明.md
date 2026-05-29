# World Cup AI Discord Bot

这是给你的 Discord 世界杯群准备的足球机器人。

它可以先免费运行基础版：

- `/ping` 检查机器人是否在线
- `/today` 查看今日/近期比赛
- `/briefing` 生成足球简报
- `@World Cup AI Bot` 询问比赛、比分、新闻，机器人会回复
- 自动定时发足球简报到指定频道

没有足球 API key 时，它会使用演示数据。拿到 API-Football key 后，可以切换成真实赛程/比分数据。

## 第 1 步：创建 Discord Bot

1. 打开 Discord Developer Portal：
   <https://discord.com/developers/applications>
2. 点 **New Application**
3. 名字填：
   `World Cup AI Bot`
4. 左边点 **Bot**
5. 点 **Add Bot**
6. 点 **Reset Token** 或 **Copy Token**
7. 把 Token 保存好，后面要放进 `.env`

注意：Token 像密码一样，不能发给别人。

## 第 2 步：打开必要权限

在 Developer Portal 里：

1. 点你的应用
2. 左边点 **Bot**
3. 找到 **Privileged Gateway Intents**
4. 这个机器人基础版不需要打开 Message Content Intent

## 第 3 步：邀请机器人进你的 Discord 群

1. Developer Portal 左边点 **OAuth2**
2. 点 **URL Generator**
3. Scopes 勾选：
   - `bot`
   - `applications.commands`
4. Bot Permissions 勾选：
   - `Send Messages`
   - `Embed Links`
   - `Read Message History`
   - `Use Slash Commands`
5. 复制下面生成的链接
6. 打开链接，选择你的服务器 **World Cup AI Club**
7. 点授权

## 第 4 步：准备本地运行

在这个文件夹里复制一份环境文件：

```text
.env.example 复制成 .env
```

然后把 `.env` 内容填好：

```text
DISCORD_TOKEN=你的机器人Token
DISCORD_CLIENT_ID=你的Application ID
DISCORD_GUILD_ID=你的服务器ID
DISCORD_CHANNEL_ID=你要自动发新闻的频道ID
FOOTBALL_PROVIDER=demo
```

## 第 5 步：拿服务器 ID 和频道 ID

Discord 里需要打开开发者模式：

1. Discord 左下角点齿轮
2. 找 **高级**
3. 打开 **开发者模式**

复制服务器 ID：

1. 右键点你的服务器名字
2. 点 **复制服务器 ID**

复制频道 ID：

1. 右键点你要发新闻的频道，例如 `world-cup-news`
2. 点 **复制频道 ID**

## 第 6 步：安装和运行

在这个文件夹打开终端，运行：

```bash
node scripts/register-commands.js
node src/index.js
```

如果成功，你会看到：

```text
World Cup AI Bot logged in as ...
```

然后去 Discord 输入：

```text
/ping
/today
/briefing
@World Cup AI Bot any football news?
```

## 第 7 步：接入真实足球数据

先注册 API-Football：

<https://www.api-football.com/>

拿到 API key 后，把 `.env` 改成：

```text
FOOTBALL_PROVIDER=api-football
API_FOOTBALL_KEY=你的APIKey
API_FOOTBALL_LEAGUE_ID=1
API_FOOTBALL_SEASON=2026
```

然后重新启动机器人：

```bash
npm start
```

## 第 8 步：可选 AI 总结

如果你以后想接真正 AI 总结，可以填：

```text
OPENAI_API_KEY=你的OpenAIKey
```

不填也能运行，只是用免费模板简报。

## 常见问题

### 电脑关了机器人会不会下线？

会。放在你电脑运行时，电脑关机机器人就下线。

### 手机登录 Discord 会让机器人在线吗？

不会。机器人在线取决于机器人程序是否在运行。

### 怎么 24 小时在线？

看 `云端部署说明.md`，把机器人放到云端服务。

### 为什么不用 npm install？

这个版本是零依赖版本，直接用 Node.js 自带功能连接 Discord，所以本地不用安装 `discord.js`。

### 为什么普通消息不一定回复？

默认设置是：

```text
DISCORD_AUTO_REPLY=mention
```

所以你需要在问题里 `@World Cup AI Bot`，机器人才会回复。这样不会打扰群里的普通聊天。
