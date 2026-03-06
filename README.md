# S.H.I.T Journal PDF Fetcher

从 [shitjournal.org](https://shitjournal.org) 预印本页面抓取并下载原始 PDF 文件。

网站使用 react-pdf 在浏览器端渲染 PDF，不提供直接下载入口。本工具绕过前端渲染层，通过 Supabase Storage API 直接获取原始 PDF。

## 架构

```
用户请求
  │
  ▼
Cloudflare Worker (全球边缘节点)
  │
  ├─ /api/info    → 查询论文元数据（Cache API 缓存 24h）
  │
  └─ /api/download → 下载 PDF
       │
       ├─ R2 命中 → 直接返回 ⚡ 零回源
       │
       └─ R2 未命中 → Supabase 拉取 → 写入 R2 → 返回
                       （仅首次，后续永不回源）
```

**缓存策略**

| 数据 | 存储 | TTL |
|------|------|-----|
| 论文元数据 | Cloudflare Cache API | 24 小时 |
| PDF 文件 | Cloudflare R2 | 永久 |

## Web 界面

终端风格的单页应用，粘贴预印本 URL 或 ID 即可查看论文信息并下载 PDF。

![UI Screenshot](https://github.com/user-attachments/assets/placeholder)

## CLI

零依赖 Python 脚本，直接在终端下载 PDF。

```bash
# 传 URL
python3 fetch_pdf.py "https://shitjournal.org/preprints/e255b247-bb24-4432-8cce-4e19d4073fa3"

# 传 ID
python3 fetch_pdf.py e255b247-bb24-4432-8cce-4e19d4073fa3

# 指定输出文件名
python3 fetch_pdf.py e255b247-bb24-4432-8cce-4e19d4073fa3 output.pdf
```

## 部署

**前置条件**：Cloudflare 账号 + 一个 R2 bucket（名为 `shitkournal-pdfs`）

```bash
# 安装 wrangler
npm install -g wrangler

# 登录
wrangler login

# 部署
wrangler deploy
```

## 本地开发

```bash
wrangler dev
```

## 技术栈

- **Runtime**: Cloudflare Workers
- **存储**: Cloudflare R2（PDF 持久化）+ Cache API（元数据）
- **数据源**: Supabase Storage（签名 URL）
- **前端**: 原生 HTML/CSS/JS，终端风格 UI
- **CLI**: Python 标准库，零依赖

## 项目结构

```
├── src/worker.js      # Cloudflare Worker（路由 + 缓存 + R2）
├── public/index.html  # Web 前端
├── fetch_pdf.py       # CLI 工具
├── wrangler.toml      # Cloudflare 配置
└── package.json
```

## License

MIT
