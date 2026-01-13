// =================================================================
// Cloudflare Worker: GitHub 文件管理器
// =================================================================

// 配置项:
// 1. 环境变量: GH_NAME, GH_TOKEN
// 2. KV 绑定: 变量名必须为 SHARE_KV
// 3. (可选) 环境变量: TOKEN

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const params = url.searchParams;
        const path = decodeURIComponent(url.pathname);

        // 1. 检查 KV
        if (!env.SHARE_KV) {
            return new Response('<h3>配置错误</h3><p>请在 Cloudflare 后台绑定 KV Namespace，变量名为 <b>SHARE_KV</b>。</p>', {
                status: 500,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        // 2. 处理分享链接
        if (path.startsWith('/s/')) {
            return await handlePublicShare(path, env);
        }

        // 3. 鉴权
        if (env.TOKEN) {
            const providedToken = params.get('token');
            if (providedToken !== env.TOKEN) {
                return new Response('Access Denied: 访问令牌无效', { status: 403 });
            }
        }
        const tokenQuery = env.TOKEN ? `?token=${env.TOKEN}` : '';

        // 4. API 路由
        if (request.method === 'POST') {
            if (path === '/api/share/create') return await createShareLink(request, env);
            if (path === '/api/share/toggle') return await toggleShareLink(request, env);
            if (path === '/api/share/delete') return await deleteShareLink(request, env);
            if (path === '/api/file/update') return await updateFile(request, env);
        }

        // 5. 管理页面
        if (path === '/admin/shares') {
            return await renderShareManager(env, tokenQuery);
        }

        // 6. 检查配置
        if (!env.GH_NAME || !env.GH_TOKEN) {
            return new Response('配置错误: 请设置 GH_NAME 和 GH_TOKEN', { status: 500 });
        }

        let cleanPath = path;
        if (cleanPath !== '/' && cleanPath.endsWith('/')) {
            cleanPath = cleanPath.slice(0, -1);
        }

        // 7. 编辑器路由
        if (params.get('edit') === 'true') {
            return await renderEditor(env, cleanPath, tokenQuery);
        }

        // 8. 核心业务逻辑
        try {
            // A. 根目录
            if (cleanPath === '/' || cleanPath === '') {
                return await listRepositories(env, tokenQuery);
            }

            // B. 获取 GitHub 内容
            const pathParts = cleanPath.split('/').filter(Boolean);
            const repoName = pathParts[0];
            const filePath = pathParts.slice(1).join('/');

            const apiUrl = `https://api.github.com/repos/${env.GH_NAME}/${repoName}/contents/${filePath}`;
            const apiResp = await githubApiFetch(apiUrl, env.GH_TOKEN);

            if (!apiResp.ok) {
                if (apiResp.status === 404) return new Response('404 文件不存在', { status: 404 });
                return new Response(`GitHub API Error: ${apiResp.status}`, { status: apiResp.status });
            }

            const data = await apiResp.json();

            // --- 修复部分在这里 ---
            // 情况1: 返回数组 -> 是文件夹 -> 直接返回 renderFileList 的结果 (它已经是 Response 对象了)
            if (Array.isArray(data)) {
                return renderFileList(data, repoName, filePath, tokenQuery);
            }
            // 情况2: 返回对象 -> 是文件 -> 代理下载
            else if (data.type === 'file') {
                return await proxyFile(data.download_url, env.GH_TOKEN);
            }

            return new Response('未知的返回类型', { status: 500 });

        } catch (e) {
            return new Response(`Worker Error: ${e.message}`, { status: 500 });
        }
    }
};

// =================================================================
// 工具函数
// =================================================================

async function githubApiFetch(url, token) {
    return await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'Cloudflare-Worker-FileManager',
            'Accept': 'application/vnd.github.v3+json'
        }
    });
}

async function proxyFile(url, token) {
    const resp = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'Cloudflare-Worker-FileManager'
        }
    });
    return new Response(resp.body, {
        status: resp.status,
        headers: resp.headers
    });
}

function decodeBase64UTF8(str) {
    const text = atob(str.replace(/\s/g, ''));
    const length = text.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = text.charCodeAt(i);
    const decoder = new TextDecoder('utf-8');
    return decoder.decode(bytes);
}

function encodeBase64UTF8(str) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// =================================================================
// 分享系统逻辑
// =================================================================

async function handlePublicShare(path, env) {
    const shareId = path.split('/s/')[1];
    if (!shareId) return new Response('无效链接', { status: 400 });

    const recordStr = await env.SHARE_KV.get(`share_${shareId}`);
    if (!recordStr) return new Response('链接不存在或已失效', { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    const record = JSON.parse(recordStr);

    if (!record.active) return new Response('该链接已被管理员停用', { status: 403, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    if (record.expireAt && Date.now() > record.expireAt) return new Response('该链接已过期', { status: 410, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    record.visits = (record.visits || 0) + 1;
    env.SHARE_KV.put(`share_${shareId}`, JSON.stringify(record)).catch(console.error);

    const parts = record.fullPath.split('/').filter(Boolean);
    const repo = parts[0];
    const filePath = parts.slice(1).join('/');
    const apiUrl = `https://api.github.com/repos/${env.GH_NAME}/${repo}/contents/${filePath}`;
    
    const apiResp = await githubApiFetch(apiUrl, env.GH_TOKEN);
    if (!apiResp.ok) return new Response('源文件无法访问', { status: 502 });
    
    const data = await apiResp.json();
    return await proxyFile(data.download_url, env.GH_TOKEN);
}

async function createShareLink(request, env) {
    const { fullPath, unit, value } = await request.json();
    let expireAt = null;
    if (unit !== 'forever') {
        const multipliers = { 'hour': 3600e3, 'day': 86400e3, 'week': 604800e3, 'month': 2592000e3, 'year': 31536000e3 };
        expireAt = Date.now() + (value * multipliers[unit]);
    }
    const shareId = crypto.randomUUID().slice(0, 8);
    const record = { id: shareId, fullPath, createdAt: Date.now(), expireAt, active: true, visits: 0 };
    await env.SHARE_KV.put(`share_${shareId}`, JSON.stringify(record));
    return new Response(JSON.stringify({ success: true, url: `${new URL(request.url).origin}/s/${shareId}` }));
}

async function toggleShareLink(request, env) {
    const { id, active } = await request.json();
    const key = `share_${id}`;
    const data = await env.SHARE_KV.get(key);
    if (data) {
        const record = JSON.parse(data);
        record.active = active;
        await env.SHARE_KV.put(key, JSON.stringify(record));
        return new Response(JSON.stringify({ success: true }));
    }
    return new Response(JSON.stringify({ success: false }));
}

async function deleteShareLink(request, env) {
    const { id } = await request.json();
    await env.SHARE_KV.delete(`share_${id}`);
    return new Response(JSON.stringify({ success: true }));
}

async function updateFile(request, env) {
    const { repo, path, sha, content } = await request.json();
    const apiUrl = `https://api.github.com/repos/${env.GH_NAME}/${repo}/contents/${path}`;
    const res = await fetch(apiUrl, {
        method: 'PUT',
        headers: {
            'Authorization': `token ${env.GH_TOKEN}`,
            'User-Agent': 'Cloudflare-Worker-FileManager',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: 'Update via Web Manager',
            content: encodeBase64UTF8(content),
            sha: sha
        })
    });
    if (res.ok) return new Response(JSON.stringify({ success: true }));
    const err = await res.json();
    return new Response(JSON.stringify({ success: false, message: err.message }), { status: 400 });
}

// =================================================================
// 页面渲染函数
// =================================================================

// 1. 在线编辑器
async function renderEditor(env, path, tokenQuery) {
    const pathParts = path.split('/').filter(Boolean);
    const repoName = pathParts[0];
    const filePath = pathParts.slice(1).join('/');
    
    const apiUrl = `https://api.github.com/repos/${env.GH_NAME}/${repoName}/contents/${filePath}`;
    const resp = await githubApiFetch(apiUrl, env.GH_TOKEN);
    if (!resp.ok) return new Response('无法读取文件内容', { status: 500 });
    
    const data = await resp.json();
    let content = data.encoding === 'base64' ? decodeBase64UTF8(data.content) : (data.content || '');

    const html = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>编辑 - ${data.name}</title>
        <style>
            body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #1e1e1e; color: #d4d4d4; font-family: sans-serif; }
            .header { height: 50px; background: #252526; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; border-bottom: 1px solid #333; }
            .title { font-weight: bold; font-size: 14px; }
            .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; margin-left: 10px; font-weight: 600; font-size: 12px; }
            .btn-back { background: #333; color: #ccc; }
            .btn-save { background: #0078d4; color: white; }
            .btn-save:hover { background: #0062a3; }
            textarea { flex: 1; background: #1e1e1e; color: #d4d4d4; border: none; padding: 20px; font-family: 'Consolas', monospace; font-size: 14px; line-height: 1.5; resize: none; outline: none; }
        </style>
    </head>
    <body>
        <div class="header">
            <div class="title">📝 编辑文件: ${data.name}</div>
            <div>
                <span id="msg" style="margin-right:10px; font-size:12px; color:#aaa"></span>
                <button class="btn btn-back" onclick="history.back()">返回</button>
                <button class="btn btn-save" onclick="save()">保存修改</button>
            </div>
        </div>
        <textarea id="code" spellcheck="false"></textarea>
        <script>
            const raw = ${JSON.stringify(content)};
            document.getElementById('code').value = raw;
            async function save() {
                const btn = document.querySelector('.btn-save');
                const msg = document.getElementById('msg');
                btn.innerText = '保存中...'; btn.disabled = true;
                try {
                    const res = await fetch('/api/file/update${tokenQuery}', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            repo: '${repoName}',
                            path: '${filePath}',
                            sha: '${data.sha}',
                            content: document.getElementById('code').value
                        })
                    });
                    const d = await res.json();
                    if(d.success) {
                        msg.innerText = '✅ 保存成功';
                        msg.style.color = '#4caf50';
                        setTimeout(() => location.reload(), 1000);
                    } else {
                        msg.innerText = '❌ ' + d.message;
                        msg.style.color = 'red';
                    }
                } catch(e) {
                    msg.innerText = '❌ 网络错误';
                }
                btn.innerText = '保存修改'; btn.disabled = false;
            }
            document.getElementById('code').addEventListener('keydown', function(e) {
                if (e.key == 'Tab') {
                    e.preventDefault();
                    this.setRangeText('\\t', this.selectionStart, this.selectionEnd, 'end');
                }
            });
        </script>
    </body>
    </html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 2. 仓库列表页面
async function listRepositories(env, tokenQuery) {
    const apiUrl = `https://api.github.com/user/repos?per_page=100&sort=updated&visibility=all&affiliation=owner`;
    const resp = await githubApiFetch(apiUrl, env.GH_TOKEN);
    const repos = await resp.json();
    
    let html = generateBaseHtml('我的云盘', tokenQuery);

    html += `
    <div class="main-container">
        <div class="toolbar">
            <div class="title">☁️ 仓库列表</div>
            <div class="actions">
                <button onclick="setView('list')" title="详细列表">≣</button>
                <button onclick="setView('grid')" title="大图标">⊞</button>
                <a href="/admin/shares${tokenQuery}" class="btn-link">⏱ 分享历史</a>
            </div>
        </div>
        
        <div id="file-list" class="grid-view">`;

    repos.forEach(repo => {
        const isPriv = repo.private;
        const icon = isPriv ? '🔒' : '🌐';
        html += `
        <a href="/${repo.name}${tokenQuery}" class="item-card">
            <div class="icon-wrapper repo-icon">
                ${icon}
            </div>
            <div class="item-info">
                <div class="item-name">${repo.name}</div>
                <div class="item-meta">${new Date(repo.updated_at).toLocaleDateString()}</div>
            </div>
        </a>`;
    });

    html += `</div></div>${getFooterScript()}</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 3. 文件列表页面
function renderFileList(items, repoName, currentPath, tokenQuery) {
    items.sort((a, b) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'dir' ? -1 : 1;
    });

    const pathParts = currentPath.split('/').filter(Boolean);
    let breadcrumbs = `<a href="/${tokenQuery}">首页</a>`;
    let accumPath = '';
    pathParts.forEach(part => {
        accumPath += '/' + part;
        breadcrumbs += ` / <a href="/${repoName}${accumPath}${tokenQuery}">${part}</a>`;
    });

    let html = generateBaseHtml(repoName, tokenQuery);

    html += `
    <div class="main-container">
        <div class="toolbar">
            <div class="breadcrumbs">${breadcrumbs}</div>
            <div class="actions">
                <button onclick="setView('list')">≣</button>
                <button onclick="setView('grid')">⊞</button>
                <a href="/admin/shares${tokenQuery}" class="btn-link">⏱ 分享历史</a>
            </div>
        </div>
        
        <div id="file-list" class="grid-view">
            <a href="${getPathParent(repoName, currentPath)}${tokenQuery}" class="item-card back-btn">
                <div class="icon-wrapper" style="background:#f3f3f3; color:#666;">⤴️</div>
                <div class="item-info"><div class="item-name">返回上级</div></div>
            </a>
    `;

    items.forEach(item => {
        const isDir = item.type === 'dir';
        const iconData = getIcon(item.name, isDir);
        const link = `/${repoName}/${item.path}${tokenQuery}`;
        const editLink = `${link}${tokenQuery.includes('?') ? '&' : '?'}edit=true`;
        const fullPath = `${repoName}/${item.path}`;

        html += `
        <div class="item-card">
            <a href="${link}" class="full-link"></a>
            <div class="icon-wrapper ${iconData.cls}">${iconData.icon}</div>
            <div class="item-info"><div class="item-name" title="${item.name}">${item.name}</div></div>
            <div class="overlay-actions">
                ${!isDir ? `<a href="${editLink}" class="mini-btn" title="编辑">✏️</a>` : ''}
                ${!isDir ? `<div class="mini-btn" onclick="openShareModal('${fullPath}', '${item.name}')" title="分享">🔗</div>` : ''}
            </div>
        </div>`;
    });

    html += `</div></div>
    
    <div id="shareModal" class="modal">
        <div class="modal-content">
            <div class="modal-header"><h3>创建分享</h3><span class="close-btn" onclick="closeShareModal()">×</span></div>
            <div class="modal-body">
                <div class="file-name-display">📄 <span id="shareFileName">filename</span></div>
                <div class="form-group">
                    <label>有效期:</label>
                    <div style="display:flex; gap:5px;">
                        <input type="number" id="val" value="1" min="1">
                        <select id="unit"><option value="day">天</option><option value="hour">小时</option><option value="forever">永久</option></select>
                    </div>
                </div>
                <button class="primary-btn" onclick="createShare()">生成链接</button>
                <div id="result-area" style="display:none; margin-top:10px;">
                    <div style="display:flex; gap:5px;">
                        <input type="text" id="shareUrl" readonly style="flex:1">
                        <button onclick="copyShareUrl()" style="width:auto;">复制</button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <script>
        const tokenQuery = '${tokenQuery}';
        const modal = document.getElementById('shareModal');
        let currentSharePath = '';
        function openShareModal(path, name) {
            currentSharePath = path;
            document.getElementById('shareFileName').innerText = name;
            document.getElementById('result-area').style.display = 'none';
            modal.style.display = 'flex';
        }
        function closeShareModal() { modal.style.display = 'none'; }
        window.onclick = function(event) { if (event.target == modal) closeShareModal(); }
        async function createShare() {
            const btn = document.querySelector('.primary-btn');
            btn.innerText = '生成中...'; btn.disabled = true;
            try {
                const val = document.getElementById('val').value;
                const unit = document.getElementById('unit').value;
                const res = await fetch('/api/share/create' + tokenQuery, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({fullPath: currentSharePath, unit: unit, value: parseInt(val)})
                });
                const data = await res.json();
                if(data.success) {
                    document.getElementById('result-area').style.display = 'block';
                    document.getElementById('shareUrl').value = data.url;
                }
            } catch(e) { alert('网络错误'); }
            btn.innerText = '生成链接'; btn.disabled = false;
        }
        function copyShareUrl() {
            document.getElementById('shareUrl').select();
            document.execCommand('copy');
            alert('已复制');
        }
    </script>
    ${getFooterScript()}</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 4. 分享管理页面
async function renderShareManager(env, tokenQuery) {
    const list = await env.SHARE_KV.list({ prefix: 'share_' });
    let records = [];
    for (const key of list.keys) {
        const val = await env.SHARE_KV.get(key.name);
        if (val) records.push(JSON.parse(val));
    }
    records.sort((a, b) => b.createdAt - a.createdAt);

    let html = generateBaseHtml('分享管理', tokenQuery);
    html += `
    <div class="main-container">
        <div class="toolbar"><a href="/${tokenQuery}" class="btn-link">⬅️ 返回文件库</a><div class="title">分享链接管理</div></div>
        <div class="table-box">
            <table width="100%" cellpadding="10" cellspacing="0">
                <thead><tr><th>文件名</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>`;

    if (records.length === 0) {
        html += `<tr><td colspan="4" align="center" style="color:#999;">暂无分享记录</td></tr>`;
    }

    records.forEach(r => {
        const isActive = r.active && (!r.expireAt || Date.now() < r.expireAt);
        const fileName = r.fullPath.split('/').pop();
        const dateStr = r.expireAt ? new Date(r.expireAt).toLocaleDateString() : '永久';
        const statusHtml = isActive 
            ? '<span style="color:green;background:#e6ffec;padding:2px 6px;border-radius:4px;">有效</span>' 
            : '<span style="color:red;background:#fff0f0;padding:2px 6px;border-radius:4px;">失效</span>';

        html += `
        <tr id="row-${r.id}">
            <td><a href="/s/${r.id}" target="_blank" style="color:#0078d4;">${fileName}</a></td>
            <td>${dateStr}</td>
            <td>${statusHtml}</td>
            <td>
                <button onclick="toggle('${r.id}', ${r.active})" style="padding:2px 8px;">${r.active ? '停用' : '启用'}</button>
                <button onclick="del('${r.id}')" style="padding:2px 8px; color:red;">删除</button>
            </td>
        </tr>`;
    });

    html += `</tbody></table></div></div>
    <script>
        async function toggle(id, current) {
            await fetch('/api/share/toggle${tokenQuery}', {method: 'POST', body: JSON.stringify({id, active: !current})});
            location.reload();
        }
        async function del(id) {
            if(confirm('确定删除?')) {
                await fetch('/api/share/delete${tokenQuery}', {method: 'POST', body: JSON.stringify({id})});
                document.getElementById('row-'+id).remove();
            }
        }
    </script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// =================================================================
// 辅助函数与样式模板
// =================================================================

function getPathParent(repo, path) {
    if (!path) return '/';
    const parts = path.split('/');
    parts.pop();
    return parts.length > 0 ? `/${repo}/${parts.join('/')}` : `/${repo}`;
}

function getIcon(name, isDir) {
    if (isDir) return { cls: 'icon-dir', icon: '📁' };
    if (name.match(/\.(md|txt|log)$/i)) return { cls: 'icon-file', icon: '📝' };
    if (name.match(/\.(jpg|png|gif|webp|svg)$/i)) return { cls: 'icon-img', icon: '🖼️' };
    if (name.match(/\.(js|html|css|json|py|php|c|cpp)$/i)) return { cls: 'icon-code', icon: '📄' };
    if (name.match(/\.(zip|rar|7z|tar|gz)$/i)) return { cls: 'icon-file', icon: '📦' };
    return { cls: 'icon-file', icon: '📄' };
}

function getFooterScript() {
    return `
    <script>
        function setView(mode) {
            const list = document.getElementById('file-list');
            localStorage.setItem('gh_view_mode', mode);
            if (mode === 'list') {
                list.classList.add('list-mode');
                list.classList.remove('grid-view');
            } else {
                list.classList.remove('list-mode');
                list.classList.add('grid-view');
            }
        }
        if (localStorage.getItem('gh_view_mode') === 'list') {
            setView('list');
        }
    </script>`;
}

function generateBaseHtml(title, tokenQuery = '') {
    return `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title}</title>
        <style>
            :root { --primary: #0078d4; --bg: #f3f9fd; --card-bg: #ffffff; --hover-bg: #e0f0ff; --hover-border: #cce8ff; }
            body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); margin: 0; padding: 20px; color: #333; }
            a { text-decoration: none; color: inherit; }
            button { cursor: pointer; }
            .main-container { max-width: 1200px; margin: 0 auto; }
            
            .toolbar {
                background: rgba(255,255,255,0.7); backdrop-filter: blur(10px);
                padding: 12px 20px; border-radius: 8px; margin-bottom: 20px;
                display: flex; justify-content: space-between; align-items: center;
                border: 1px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.03);
            }
            .title { font-weight: bold; font-size: 16px; }
            .breadcrumbs { font-size: 14px; color: #666; }
            .breadcrumbs a:hover { color: #000; text-decoration: underline; }
            .actions button, .btn-link {
                background: transparent; border: 1px solid transparent; padding: 6px 10px;
                border-radius: 4px; font-size: 14px; color: #555; transition: 0.2s;
            }
            .actions button:hover, .btn-link:hover { background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.05); color: var(--primary); }
            .btn-link { border: 1px solid #ddd; background: #fff; margin-left: 10px; display: inline-block; }

            /* Grid View */
            .grid-view { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 12px; }
            .item-card {
                display: flex; flex-direction: column; align-items: center; justify-content: flex-start;
                background: var(--card-bg); border: 1px solid transparent; border-radius: 6px;
                padding: 15px 5px; height: 120px; position: relative; transition: all 0.2s;
            }
            .item-card:hover { background: var(--hover-bg); border-color: var(--hover-border); transform: translateY(-2px); box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
            
            .icon-wrapper { width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; font-size: 32px; margin-bottom: 8px; border-radius: 8px; }
            .icon-dir { color: #dcb67a; } .icon-file { color: var(--primary); } .icon-img { color: #8a2be2; } .icon-code { color: #107c10; } .repo-icon { font-size: 36px; }

            .item-info { width: 100%; text-align: center; padding: 0 5px; box-sizing: border-box; }
            .item-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 3px; }
            .item-meta { font-size: 11px; color: #999; }
            .full-link { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; }

            .overlay-actions { position: absolute; top: 5px; right: 5px; display: none; gap: 5px; z-index: 2; }
            .item-card:hover .overlay-actions { display: flex; }
            .mini-btn { width: 24px; height: 24px; background: #fff; border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); color: #555; }
            .mini-btn:hover { color: var(--primary); }

            /* List View */
            .list-mode { display: flex; flex-direction: column; gap: 0; }
            .list-mode .item-card {
                flex-direction: row; height: 44px; width: 100%; padding: 0 15px;
                border-radius: 0; border-bottom: 1px solid #eee; justify-content: flex-start;
                box-shadow: none; margin-bottom: 0;
            }
            .list-mode .item-card:hover { transform: none; background: #fcfcfc; }
            .list-mode .icon-wrapper { width: 30px; height: 30px; font-size: 20px; margin-bottom: 0; margin-right: 15px; }
            .list-mode .item-info { text-align: left; flex: 1; }
            .list-mode .overlay-actions { position: static; display: flex; margin-left: auto; }
            .list-mode .mini-btn { background: transparent; box-shadow: none; }

            /* Modal & Table */
            .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; z-index: 999; backdrop-filter: blur(3px); }
            .modal-content { background: #fff; width: 320px; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.2); overflow: hidden; }
            .modal-header { background: #f9f9f9; padding: 12px 15px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
            .modal-header h3 { margin: 0; font-size: 16px; }
            .close-btn { cursor: pointer; font-size: 20px; color: #999; }
            .modal-body { padding: 20px; }
            .file-name-display { background: #f3f3f3; padding: 8px; border-radius: 4px; color: #555; font-size: 13px; margin-bottom: 15px; word-break: break-all; }
            .form-group { margin-bottom: 15px; }
            input, select { padding: 8px; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
            .primary-btn { width: 100%; background: var(--primary); color: #fff; padding: 10px; border: none; border-radius: 4px; font-weight: bold; }
            
            .table-box { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
            th { text-align: left; background: #fafafa; border-bottom: 1px solid #eee; color: #666; }
            td { border-bottom: 1px solid #fcfcfc; }
            @media (max-width: 600px) {
                .grid-view { grid-template-columns: repeat(auto-fill, minmax(90px, 1fr)); } .item-card { height: 110px; }
                .overlay-actions { display: flex; position: absolute; top: auto; bottom: 5px; right: 5px; } .list-mode .overlay-actions { margin-left: auto; position: static; }
            }
        </style>
    </head>
    <body>`;
}
