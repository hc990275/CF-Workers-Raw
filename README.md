原项目地址: https://github.com/cmliu/CF-Workers-Raw

# 📁 Cloudflare Workers GitHub File Manager (Pro Max)

这是一个运行在 Cloudflare Workers 上的高级 GitHub 文件管理器。它将您的 GitHub 仓库转化为一个私有云盘，支持**首页登录保护**、**Windows 11 风格界面**、**在线代码编辑**以及**无需密码的公开分享**功能。

## ✨ 核心特性

* **🔒 首页安全锁**：未登录用户访问首页会看到漂亮的登录界面，必须输入密码才能进入。
* **🌍 公开分享系统**：
    * 生成的分享链接（`/s/xxxx`）是**公开**的。
    * 接收者**不需要密码**即可直接下载/查看文件。
    * 支持设置有效期（小时/天/周/永久），过期自动失效。
* **💻 现代化 UI**：
    * **默认大图标视图**：类似 Windows 11 资源管理器的网格布局。
    * **列表视图切换**：支持一键切换为详细列表模式。
    * **移动端适配**：在手机和平板上也能完美使用。
* **✏️ 在线编辑**：内置代码编辑器，支持直接修改 GitHub 文件并自动 Commit，支持 Tab 缩进。
* **⚡ 极速体验**：基于 Cloudflare 全球边缘网络，不消耗服务器资源。

---

## 🛠️ 部署指南

### 1. 准备 GitHub Token
1.  登录 GitHub，进入 [Settings -> Developer settings -> Personal access tokens (Tokens (classic))](https://github.com/settings/tokens).
2.  点击 **Generate new token (classic)**。
3.  **Scopes** (权限) 必须勾选 **`repo`** (Full control of private repositories)。
4.  生成并复制 Token（`ghp_` 开头的字符串）。

### 2. 创建 Cloudflare KV (必须)
本项目使用 KV 存储分享链接数据。
1.  登录 Cloudflare Dashboard。
2.  进入 **Workers & Pages** -> **KV**。
3.  点击 **Create a Namespace**，命名为 `SHARE_DB` (或者任意名字)，点击 Add。
4.  **记住这个 KV 数据库，下一步要用到。**

### 3. 创建 Worker 并配置
1.  创建一个新的 Worker，将本项目提供的 `worker.js` 代码完整复制进去。
2.  进入 Worker 的 **Settings (设置)** -> **Variables (变量)**。

#### 3.1 绑定 KV (KV Namespace Bindings)
点击 **Add binding**：
* **Variable name (变量名)**: 必须填写 `SHARE_KV` (⚠️必须完全一致，不可更改)。
* **KV Namespace**: 选择第 2 步创建的数据库。

#### 3.2 设置环境变量 (Environment Variables)
点击 **Add variable**，添加以下变量：

| 变量名称 | 是否必须 | 示例值 | 说明 |
| :--- | :---: | :--- | :--- |
| `GH_NAME` | **是** | `your_user` | 您的 GitHub 用户名 |
| `GH_TOKEN` | **是** | `ghp_xxxx` | 第1步申请的 GitHub Token |
| `TOKEN` | **是** | `123456` | **您的后台登录密码**。如果不设置，任何人都能管理您的仓库！ |

3.  点击 **Save and Deploy** (保存并部署)。

---

## 📖 使用说明

### 1. 登录后台
* 访问 `https://您的域名.workers.dev`。
* 您会看到一个“🔒 管理员登录”页面。
* 输入您在环境变量 `TOKEN` 中设置的密码即可进入。

### 2. 文件管理
* **浏览**：支持点击文件夹进入，点击顶部面包屑或“返回上级”卡片返回。
* **视图切换**：点击右上角的 `≣` (列表) 或 `⊞` (图标) 切换显示模式。

### 3. 分享文件
* 将鼠标悬停在文件上（手机端直接显示），点击 **🔗** 图标。
* 选择有效期（例如 1天），点击“生成链接”。
* 复制链接发给朋友，**朋友打开链接直接下载，无需输入密码**。

### 4. 在线编辑
* 将鼠标悬停在代码/文本文件上，点击 **✏️** 图标。
* 进入编辑器修改内容，点击右上角“保存”。
* 系统会自动向 GitHub 提交 Commit。

### 5. 管理分享
* 点击右上角的 **⏱ 分享历史**。
* 您可以查看所有分享链接的访问次数、过期时间。
* 支持手动 **停用** 或 **删除** 某个分享链接。

---

## ⚠️ 免责声明

* 本项目基于 Cloudflare Workers 运行，所有文件操作直接对接 GitHub API。
* 请务必保管好您的 `GH_TOKEN` 和 `TOKEN` (登录密码)，泄露可能导致仓库被篡改。
* 分享链接是公开的，请勿分享包含敏感信息的文件给不可信的人。

---

**License** MIT License
