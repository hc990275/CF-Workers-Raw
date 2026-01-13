原项目地址: https://github.com/cmliu/CF-Workers-Raw

# 📁 Cloudflare Workers GitHub File Manager (Pro Max)

这是一个基于 Cloudflare Workers 的高级 GitHub 文件管理器。它将您的 GitHub 仓库转化为一个功能强大的个人网盘，拥有类似 Windows 11 的现代化界面，支持在线浏览、代码编辑以及强大的文件分享系统。

## ✨ 主要功能

* **🖥️ Windows 11 Fluent 风格 UI**：极致美化的界面，支持磨砂玻璃效果、圆角卡片和流畅的交互动画。
* **👀 多种视图模式**：
    * **大图标模式 (默认)**：类似 Windows 资源管理器的网格布局，直观清晰。
    * **详细列表模式**：适合文件较多的场景，显示更多细节。
* **✏️ 在线代码编辑**：内置轻量级代码编辑器，支持直接修改 GitHub 文件并自动 Commit 保存，支持 Tab 缩进。
* **🔗 强大的分享系统**：
    * 基于 **Cloudflare KV** 存储。
    * 支持生成公开分享链接（无需密码即可访问）。
    * **自定义有效期**：支持设置 小时、天、周、月、年 或 永久有效。
    * **管理面板**：提供独立的仪表盘，可查看所有分享历史、访问次数，支持随时停用或删除链接。
* **📱 完美移动端适配**：在手机和平板上也能流畅使用。
* **🔒 安全鉴权**：支持设置访问密码（Token），保护您的仓库不被未授权访问。

---

## 🛠️ 部署指南

### 1. 创建 KV 命名空间 (必须)

本项目依赖 Cloudflare KV 来存储分享链接的数据。**在部署代码之前，请务必先创建并绑定 KV。**

1.  登录 Cloudflare Dashboard。
2.  进入 **Workers & Pages** -> **KV**。
3.  点击 **Create a Namespace**，随便起个名字（例如 `Github_Share_DB`），点击 Add。
4.  回到你的 Worker 项目 -> **Settings** (设置) -> **Variables** (变量)。
5.  在 **KV Namespace Bindings** 区域，点击 **Add binding**。
6.  **关键步骤**：
    * **Variable name (变量名)**: 必须填写 `SHARE_KV` (大小写敏感，不可更改)。
    * **KV Namespace**: 选择你刚才创建的数据库。
7.  点击 **Save and Deploy**。

### 2. 设置环境变量 (Environment Variables)

请在 Worker 的 **Settings** -> **Variables** -> **Environment Variables** 中添加以下变量：

| 变量名称 | 是否必须 | 示例值 | 说明 |
| :--- | :---: | :--- | :--- |
| `GH_NAME` | **是** | `yourname` | 您的 GitHub 用户名。 |
| `GH_TOKEN` | **是** | `ghp_xxxxxx` | GitHub Personal Access Token (Classic)。<br>需要在 GitHub 设置中生成，**必须勾选 `repo` 权限**以访问私有仓库和进行编辑。 |
| `TOKEN` | 否 | `password123` | **强烈建议设置**。这是访问此 Worker 网站的密码。<br>如果不设置，任何人知道网址都能管理你的仓库。<br>设置后，访问首页需加上 `?token=你的密码`。 |

---

## 📖 使用说明

### 首次访问
如果您设置了 `TOKEN` 环境变量，首次访问时请使用带参数的链接：
`https://您的域名.workers.dev/?token=您的密码`

系统会自动传递 Token，后续点击文件夹或文件无需重复输入。

### 文件分享
1.  在文件列表（大图标或列表模式）中，将鼠标悬停在文件卡片上。
2.  点击出现的 **🔗 (链接图标)** 按钮。
3.  在弹出的窗口中设置有效期（如 1天、永久等）。
4.  点击生成，复制链接发送给他人即可。
    * *注意：分享出去的链接是只读的，访问者无法编辑文件，也不需要输入 Token。*

### 在线编辑
1.  鼠标悬停在文件上，点击 **✏️ (铅笔图标)**。
2.  进入编辑页面修改代码。
3.  点击右上角的 **💾 保存**，Worker 会自动通过 API 将更改推送到 GitHub。

### 管理分享历史
点击页面右上角的 **⏱ 分享历史** 按钮，进入管理面板。您可以：
* 查看每个链接的访问次数。
* 查看链接是否过期。
* 手动 **停用/启用** 某个链接。
* 彻底 **删除** 分享记录。

---

## ⚠️ 注意事项

* **GitHub Token 权限**：`GH_TOKEN` 必须拥有对仓库的读写权限，否则无法读取私有库或保存修改。
* **安全性**：请保管好您的 Worker URL 和 Token。虽然分享链接是安全的（只读），但 Worker 首页拥有完全的管理权限。

---

### 开源协议
MIT License
