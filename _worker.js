// =================================================================
// Cloudflare Worker: GitHub 私有文件管理器 (终极稳定版)
// =================================================================
// 核心功能：
// 1. 访客访问首页 -> 显示登录页 (保护隐私)
// 2. 管理员登录 -> 拥有全部权限 (浏览/编辑/分享/管理)
// 3. 分享链接 -> 公开访问 (无需密码，方便分享给他人)
// =================================================================

// 环境变量配置 (在 Cloudflare 后台设置):
// 1. GH_NAME: 您的 GitHub 用户名
// 2. GH_TOKEN: 您的 GitHub Token (需要勾选 repo 权限)
// 3. SHARE_KV: 绑定的 KV 命名空间 (必须命名为 SHARE_KV)
// 4. TOKEN: 设置您的登录密码 (强烈建议设置！)

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const params = url.searchParams;
        const path = decodeURIComponent(url.pathname);

        // --- 1. 系统自检 ---
        // 检查是否绑定了 KV 数据库
        if (!env.SHARE_KV) {
            return new Response('<h3>配置错误</h3><p>未检测到 KV 绑定。请在后台绑定变量名为 <b>SHARE_KV</b> 的 KV 空间。</p>', {
                status: 500,
                headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
        }

        // --- 2. 处理公共分享 (完全公开，无需密码) ---
        // 只要路径是 /s/ 开头，就认为是访问分享文件
        if (path.startsWith('/s/')) {
            return await handlePublicShare(path, env);
        }

        // --- 3. 网站登录鉴权 (保护后台) ---
        // 获取 URL 上的 ?token= 参数
        const userToken = params.get('token');
        
        // 如果设置了密码 (TOKEN)，但用户没输或者输错了
        if (env.TOKEN && userToken !== env.TOKEN) {
            // 如果是 API 请求，返回 403 禁止
            if (path.startsWith('/api/')) {
                return new Response(JSON.stringify({ success: false, message: '登录已失效，请刷新页面' }), { 
                    status: 403, headers: {'Content-Type': 'application/json'} 
                });
            }
            // 如果是普通访问，显示登录页面
            return new Response(renderLoginPage(), { 
                headers: { 'Content-Type': 'text/html; charset=utf-8' } 
            });
        }

        // 登录验证通过！生成后续操作需要的 token 字符串
        const tokenQuery = env.TOKEN ? `?token=${env.TOKEN}` : '';

        // --- 4. 管理员 API (增删改查) ---
        // 能走到这里说明已经通过了第 3 步的密码验证，拥有最高权限
        if (request.method === 'POST') {
            if (path === '/api/share/create') return await createShareLink(request, env);
            if (path === '/api/share/toggle') return await toggleShareLink(request, env);
            if (path === '/api/share/delete') return await deleteShareLink(request, env);
            if (path === '/api/file/update') return await updateFile(request, env);
        }

        // --- 5. 管理员页面路由 ---
        if (path === '/admin/shares') {
            return await renderShareManager(env, tokenQuery);
        }
        
        // 检查 GitHub 配置
        if (!env.GH_NAME || !env.GH_TOKEN) {
            return new Response('错误: 缺少 GH_NAME 或 GH_TOKEN 环境变量', { status: 500 });
        }

        // 处理路径末尾斜杠
        let cleanPath = path;
        if (cleanPath !== '/' && cleanPath.endsWith('/')) {
            cleanPath = cleanPath.slice(0, -1);
        }

        // --- 6. 编辑器路由 ---
        if (params.get('edit') === 'true') {
            return await renderEditor(env, cleanPath, tokenQuery);
        }

        // --- 7. 核心业务: 浏览 GitHub 仓库 ---
        try {
            // A. 根目录 -> 列出所有仓库
            if (cleanPath === '/' || cleanPath === '') {
                return await listRepositories(env, tokenQuery);
            }

            // B. 子目录/文件 -> 获取内容
            const pathParts = cleanPath.split('/').filter(Boolean);
            const repoName = pathParts[0];
            const filePath = pathParts.slice(1).join('/');
            
            const apiUrl = `https://api.github.com/repos/${env.GH_NAME}/${repoName}/contents/${filePath}`;
            const apiResp = await githubApiFetch(apiUrl, env.GH_TOKEN);

            if (!apiResp.ok) {
                if(apiResp.status === 404) return new Response('404 文件或目录不存在', {status: 404});
                return new Response(`GitHub API 错误: ${apiResp.status}`, { status: apiResp.status });
            }

            const data = await apiResp.json();

            // 如果是文件夹 -> 渲染文件列表
            if (Array.isArray(data)) {
                return new Response(renderFileList(data, repoName, filePath, tokenQuery), {
                    headers: { 'Content-Type': 'text/html; charset=utf-8' }
                });
            } 
            // 如果是文件 -> 代理下载
            else if (data.type === 'file') {
                return await proxyFile(data.download_url, env.GH_TOKEN);
            }

            return new Response('未知的返回类型', { status: 500 });

        } catch (e) {
            return new Response(`Worker 内部错误: ${e.message}`, { status: 500 });
        }
    }
};

// =================================================================
// 🛠️ 核心工具函数
// =================================================================

// 统一 GitHub API 请求
async function githubApiFetch(url, token) {
    return await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'Cloudflare-Worker-FileManager',
            'Accept': 'application/vnd.github.v3+json'
        }
    });
}

// 代理文件流 (隐藏真实 GitHub 地址)
async function proxyFile(url, token) {
    const r = await fetch(url, {
        headers: {
            'Authorization': `token ${token}`,
            'User-Agent': 'Cloudflare-Worker-FileManager'
        }
    });
    return new Response(r.body, { status: r.status, headers: r.headers });
}

// Base64 解码 (UTF-8 增强版，防止中文乱码)
function decodeBase64UTF8(str) {
    const text = atob(str.replace(/\s/g, ''));
    const length = text.length;
    const bytes = new Uint8Array(length);
    for (let i = 0; i < length; i++) bytes[i] = text.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
}

// Base64 编码 (UTF-8 增强版)
function encodeBase64UTF8(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

// =================================================================
// 🌍 分享系统逻辑 (KV 数据库)
// =================================================================

// 1. 处理公共分享访问 (无密码验证)
async function handlePublicShare(path, env) {
    const id = path.split('/s/')[1];
    if (!id) return new Response('无效链接', { status: 400 });

    const val = await env.SHARE_KV.get(`share_${id}`);
    if (!val) return new Response('<h3>🔗 链接不存在或已失效</h3>', { status: 404, headers: {'Content-Type': 'text/html;charset=utf-8'} });

    const record = JSON.parse(val);

    // 检查是否被停用
    if (!record.active) return new Response('<h3>⛔ 该链接已被管理员停用</h3>', { status: 403, headers: {'Content-Type': 'text/html;charset=utf-8'} });
    
    // 检查是否过期
    if (record.expireAt && Date.now() > record.expireAt) {
        return new Response('<h3>⌛ 该链接已过期</h3>', { status: 410, headers: {'Content-Type': 'text/html;charset=utf-8'} });
    }

    // 记录访问次数 (不阻塞)
    record.visits = (record.visits || 0) + 1;
    env.SHARE_KV.put(`share_${id}`, JSON.stringify(record)).catch(()=>{});

    // 获取源文件
    const parts = record.fullPath.split('/').filter(Boolean);
    const api = await githubApiFetch(`https://api.github.com/repos/${env.GH_NAME}/${parts[0]}/contents/${parts.slice(1).join('/')}`, env.GH_TOKEN);
    
    if (!api.ok) return new Response('源文件无法访问', { status: 502 });
    return await proxyFile((await api.json()).download_url, env.GH_TOKEN);
}

// 2. 创建分享 (管理员权限)
async function createShareLink(r, env) {
    const { fullPath, unit, value } = await r.json();
    let exp = null;
    // 计算过期时间戳
    if (unit !== 'forever') {
        const msMap = { 'hour': 3600e3, 'day': 86400e3, 'week': 604800e3, 'month': 2592000e3, 'year': 31536000e3 };
        exp = Date.now() + (value * msMap[unit]);
    }
    const id = crypto.randomUUID().slice(0, 8); // 生成8位短ID
    const record = { id, fullPath, createdAt: Date.now(), expireAt: exp, active: true, visits: 0 };
    
    await env.SHARE_KV.put(`share_${id}`, JSON.stringify(record));
    return new Response(JSON.stringify({ success: true, url: `${new URL(r.url).origin}/s/${id}` }));
}

// 3. 切换状态/删除 (管理员权限)
async function toggleShareLink(r, e) {
    const { id, active } = await r.json();
    const k = `share_${id}`;
    const d = JSON.parse(await e.SHARE_KV.get(k));
    if (d) { d.active = active; await e.SHARE_KV.put(k, JSON.stringify(d)); }
    return new Response(JSON.stringify({ success: !!d }));
}

async function deleteShareLink(r, e) {
    const { id } = await r.json();
    await e.SHARE_KV.delete(`share_${id}`);
    return new Response(JSON.stringify({ success: true }));
}

// 4. 更新文件 (管理员权限)
async function updateFile(r, e) {
    const { repo, path, sha, content } = await r.json();
    const res = await fetch(`https://api.github.com/repos/${e.GH_NAME}/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${e.GH_TOKEN}`, 'User-Agent': 'WF', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Update via Web Manager', content: encodeBase64UTF8(content), sha: sha })
    });
    if (res.ok) return new Response(JSON.stringify({ success: true }));
    return new Response(JSON.stringify({ success: false, message: (await res.json()).message }), { status: 400 });
}


// =================================================================
// 🎨 UI 页面渲染函数
// =================================================================

// 🔒 0. 登录页面 (这是你看到的第一页)
function renderLoginPage() {
    return `<!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>登录 - 私有云盘</title>
        <style>
            body { background: #f0f2f5; height: 100vh; display: flex; align-items: center; justify-content: center; font-family: "Segoe UI", sans-serif; margin: 0; }
            .login-card { background: white; padding: 40px 30px; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.08); width: 320px; text-align: center; }
            h2 { margin-top: 0; color: #333; font-size: 22px; margin-bottom: 25px; }
            .input-box { width: 100%; padding: 12px; margin-bottom: 20px; border: 1px solid #ddd; border-radius: 8px; box-sizing: border-box; font-size: 16px; outline: none; transition: 0.3s; }
            .input-box:focus { border-color: #0078d4; box-shadow: 0 0 0 2px rgba(0,120,212,0.2); }
            .btn { width: 100%; padding: 12px; background: #0078d4; color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer; transition: 0.3s; }
            .btn:hover { background: #0062a3; }
            .tips { color: #888; font-size: 12px; margin-top: 20px; }
        </style>
    </head>
    <body>
        <div class="login-card">
            <h2>🔒 管理员登录</h2>
            <input type="password" id="pass" class="input-box" placeholder="请输入访问密码..." onkeypress="if(event.keyCode==13) doLogin()">
            <button class="btn" onclick="doLogin()">进入云盘</button>
            <div class="tips">此系统仅限管理员访问<br>分享链接无需登录即可查看</div>
        </div>
        <script>
        function doLogin(){
            const p = document.getElementById('pass').value;
            if(p) {
                // 将密码拼接到 URL 参数中
                window.location.href = '/?token=' + encodeURIComponent(p);
            } else {
                alert('密码不能为空');
            }
        }
        </script>
    </body>
    </html>`;
}

// 📝 1. 在线编辑器
async function renderEditor(env, path, tokenQuery) {
    const parts = path.split('/').filter(Boolean);
    const repo = parts[0]; const file = parts.slice(1).join('/');
    const resp = await githubApiFetch(`https://api.github.com/repos/${env.GH_NAME}/${repo}/contents/${file}`, env.GH_TOKEN);
    const data = await resp.json();
    const content = data.encoding === 'base64' ? decodeBase64UTF8(data.content) : (data.content || '');

    const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>编辑 - ${data.name}</title><style>
    body{margin:0;height:100vh;display:flex;flex-direction:column;background:#1e1e1e;color:#ccc;font-family:Consolas, monospace}
    .head{background:#252526;height:50px;display:flex;justify-content:space-between;align-items:center;padding:0 20px;border-bottom:1px solid #333}
    .btn{padding:6px 15px;border:none;border-radius:4px;cursor:pointer;margin-left:10px;font-weight:600;font-family:sans-serif}
    .btn-c{background:#3c3c3c;color:#ccc}.btn-s{background:#0078d4;color:#fff}
    textarea{flex:1;background:#1e1e1e;color:#d4d4d4;border:none;padding:20px;font-family:inherit;resize:none;outline:none;font-size:14px;line-height:1.6}
    </style></head><body>
    <div class="head"><span>📝 ${data.name}</span><div><span id="msg" style="margin-right:15px;font-size:12px"></span><button class="btn btn-c" onclick="history.back()">返回</button><button class="btn btn-s" onclick="save()">保存</button></div></div>
    <textarea id="code" spellcheck="false"></textarea>
    <script>
    document.getElementById('code').value=${JSON.stringify(content)};
    async function save(){
        const b=document.querySelector('.btn-s'),m=document.getElementById('msg');b.innerText='保存中...';b.disabled=true;
        try{
            const r=await fetch('/api/file/update${tokenQuery}',{method:'POST',body:JSON.stringify({repo:'${repo}',path:'${file}',sha:'${data.sha}',content:document.getElementById('code').value})});
            const d=await r.json();
            if(d.success){m.innerText='✅ 保存成功';m.style.color='#4caf50';setTimeout(()=>location.reload(),800);}
            else{m.innerText='❌ '+d.message;m.style.color='red';}
        }catch(e){m.innerText='❌ 网络错误';}b.innerText='保存';b.disabled=false;
    }
    document.getElementById('code').addEventListener('keydown',function(e){if(e.key=='Tab'){e.preventDefault();this.setRangeText('\\t',this.selectionStart,this.selectionEnd,'end');}});
    </script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 📂 2. 仓库列表 (首页)
async function listRepositories(env, tokenQuery) {
    const repos = await (await githubApiFetch(`https://api.github.com/user/repos?per_page=100&sort=updated`, env.GH_TOKEN)).json();
    let html = generateBaseHtml('我的云盘', tokenQuery);
    // 渲染卡片
    let listHtml = '';
    repos.forEach(r => {
        listHtml += `<a href="/${r.name}${tokenQuery}" class="item">
            <div class="icon ${r.private?'priv':''}">${r.private?'🔒':'🌐'}</div>
            <div class="txt">
                <div class="n">${r.name}</div>
                <div class="m">${new Date(r.updated_at).toLocaleDateString()}</div>
            </div>
        </a>`;
    });
    
    html += `<div class="main">
        <div class="bar">
            <h3>☁️ 仓库列表</h3>
            <div class="acts">
                <button onclick="v('list')" title="列表视图">≣</button>
                <button onclick="v('grid')" title="大图标视图">⊞</button>
                <a href="/admin/shares${tokenQuery}" class="btn">⏱ 分享历史</a>
            </div>
        </div>
        <div id="list" class="grid">${listHtml}</div>
    </div>${ft()}</body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// 📄 3. 文件列表
function renderFileList(items, repo, path, tokenQuery) {
    items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    const parts = path.split('/').filter(Boolean);
    
    // 面包屑
    let bread = `<a href="/${tokenQuery}">首页</a>`;
    let acc = ''; 
    parts.forEach(p => { acc += '/' + p; bread += ` / <a href="/${repo}${acc}${tokenQuery}">${p}</a>` });

    let html = generateBaseHtml(`${repo}`, tokenQuery);
    
    let listHtml = `<a href="${getPathParent(repo, path)}${tokenQuery}" class="item back">
        <div class="icon" style="background:#f3f3f3;color:#666">⤴️</div>
        <div class="txt"><div class="n">返回上级</div></div>
    </a>`;

    items.forEach(i => {
        const isDir = i.type === 'dir';
        const ico = getIcon(i.name, isDir);
        const link = `/${repo}/${i.path}${tokenQuery}`;
        const edit = `${link}${tokenQuery.includes('?') ? '&' : '?'}edit=true`;
        
        // 既然登录了，就有操作按钮
        const actions = !isDir ? `
            <div class="over">
                <a href="${edit}" class="mini" title="编辑文件">✏️</a>
                <div class="mini" onclick="share('${repo}/${i.path}','${i.name}')" title="分享文件">🔗</div>
            </div>` : '';
            
        listHtml += `<div class="item">
            <a href="${link}" class="link"></a>
            <div class="icon ${ico.c}">${ico.i}</div>
            <div class="txt"><div class="n" title="${i.name}">${i.name}</div></div>
            ${actions}
        </div>`;
    });

    html += `<div class="main">
        <div class="bar">
            <div class="bread">${bread}</div>
            <div class="acts">
                <button onclick="v('list')">≣</button>
                <button onclick="v('grid')">⊞</button>
                <a href="/admin/shares${tokenQuery}" class="btn">⏱ 分享历史</a>
            </div>
        </div>
        <div id="list" class="grid">${listHtml}</div>
    </div>
    <div id="mod" class="modal"><div class="card"><div class="mh"><h3>创建分享</h3><span class="x" onclick="cls()">×</span></div><div class="mb"><div class="preview">📄 <span id="fname"></span></div><div class="row"><input type="number" id="val" value="1"><select id="unit"><option value="day">天</option><option value="hour">小时</option><option value="forever">永久</option></select></div><button class="ok" onclick="gen()">生成链接</button><div id="res" class="res"><input id="url" readonly><button onclick="cp()">复制</button></div></div></div></div>
    <script>
    const tQ='${tokenQuery}',mod=document.getElementById('mod');let cpth='';
    function share(p,n){cpth=p;document.getElementById('fname').innerText=n;document.getElementById('res').style.display='none';mod.classList.add('s');}
    function cls(){mod.classList.remove('s');}
    window.onclick=e=>{if(e.target==mod)cls()};
    async function gen(){
        const b=document.querySelector('.ok');b.innerText='生成中...';b.disabled=true;
        try{
            const r=await fetch('/api/share/create'+tQ,{method:'POST',body:JSON.stringify({fullPath:cpth,unit:document.getElementById('unit').value,value:parseInt(document.getElementById('val').value)})});
            const d=await r.json();
            if(d.success){document.getElementById('res').style.display='flex';document.getElementById('url').value=d.url;}
            else{alert(d.message);}
        }catch(e){alert('网络错误');}b.innerText='生成链接';b.disabled=false;
    }
    function cp(){document.getElementById('url').select();document.execCommand('copy');}
    </script>${ft()}</body></html>`;
    return html;
}

// ⏱️ 4. 分享历史管理
async function renderShareManager(env, tQ) {
    const list = await env.SHARE_KV.list({ prefix: 'share_' });
    let recs = []; for (const k of list.keys) { const v = await env.SHARE_KV.get(k.name); if (v) recs.push(JSON.parse(v)); }
    recs.sort((a, b) => b.createdAt - a.createdAt);
    
    let html = generateBaseHtml('分享管理', tQ);
    html += `<div class="main"><div class="bar"><a href="/${tQ}" class="btn">⬅️ 返回文件库</a><h3>分享链接管理</h3></div><div class="tbl-box"><table><thead><tr><th>文件</th><th>过期时间</th><th>状态</th><th>操作</th></tr></thead><tbody>`;
    if (recs.length === 0) html += `<tr><td colspan="4" align="center" style="color:#999">暂无记录</td></tr>`;
    
    recs.forEach(r => {
        const act = r.active && (!r.expireAt || Date.now() < r.expireAt);
        html += `<tr id="r-${r.id}">
            <td><a href="/s/${r.id}" target="_blank" style="color:#0078d4">${r.fullPath.split('/').pop()}</a></td>
            <td>${r.expireAt ? new Date(r.expireAt).toLocaleDateString() : '永久'}</td>
            <td><span class="badge ${act?'ok':'no'}">${act?'有效':'失效'}</span></td>
            <td><button onclick="tog('${r.id}',${r.active})">${r.active?'停用':'启用'}</button><button onclick="del('${r.id}')" style="color:red">删除</button></td>
        </tr>`;
    });
    html += `</tbody></table></div></div>
    <script>
    async function tog(id,s){await fetch('/api/share/toggle${tQ}',{method:'POST',body:JSON.stringify({id,active:!s})});location.reload();}
    async function del(id){if(confirm('确定删除?')){await fetch('/api/share/delete${tQ}',{method:'POST',body:JSON.stringify({id})});document.getElementById('r-'+id).remove();}}
    </script></body></html>`;
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ================= 🎨 样式 & 辅助函数 =================

function getPathParent(repo, path) { const p = path ? path.split('/') : []; p.pop(); return p.length || path ? `/${repo}/${p.join('/')}` : `/${repo}`; }
function getIcon(n, d) { if (d) return { c: 'dir', i: '📁' }; if (n.match(/\.(md|txt)$/i)) return { c: 'file', i: '📝' }; if (n.match(/\.(jpg|png|gif)$/i)) return { c: 'img', i: '🖼️' }; if (n.match(/\.(js|html|css|py|json)$/i)) return { c: 'code', i: '📄' }; return { c: 'file', i: '📄' }; }
function ft() { return `<script>function v(m){const l=document.getElementById('list');localStorage.setItem('gh_v',m);if(m==='list')l.classList.add('lst');else l.classList.remove('lst');}if(localStorage.getItem('gh_v')==='list')v('list');</script>`; }

function generateBaseHtml(title, tQ) {
    return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
:root { --p: #0078d4; --bg: #f3f9fd; }
body { font-family: "Segoe UI", sans-serif; background: var(--bg); margin: 0; color: #333; }
a { text-decoration: none; color: inherit; }
.main { max-width: 1200px; margin: 0 auto; padding: 20px; }

/* 顶部栏 */
.bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; background: rgba(255,255,255,0.7); backdrop-filter: blur(10px); padding: 12px 15px; border-radius: 8px; border: 1px solid #fff; box-shadow: 0 2px 10px rgba(0,0,0,0.03); }
.bar h3 { margin: 0; font-size: 16px; }
.bread { font-size: 14px; color: #666; } .bread a:hover { color: #000; text-decoration: underline; }
.acts button, .btn { background: transparent; border: 1px solid transparent; cursor: pointer; padding: 5px 10px; border-radius: 4px; font-size: 14px; color: #555; transition: 0.2s; }
.acts button:hover, .btn:hover { background: #fff; box-shadow: 0 2px 5px rgba(0,0,0,0.05); color: var(--p); }
.btn { border: 1px solid #ddd; background: #fff; margin-left: 5px; }

/* Grid View (大图标) */
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); gap: 10px; }
.item { display: flex; flex-direction: column; align-items: center; padding: 15px 5px; background: #fff; border-radius: 6px; border: 1px solid transparent; position: relative; transition: 0.2s; height: 110px; justify-content: flex-start; }
.item:hover { background: #e0f0ff; border-color: #cce8ff; transform: translateY(-2px); box-shadow: 0 4px 10px rgba(0,0,0,0.05); }
.link { position: absolute; top: 0; left: 0; width: 100%; height: 100%; z-index: 1; }
.icon { font-size: 32px; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; border-radius: 10px; margin-bottom: 8px; }
.dir { color: #dcb67a; } .file { color: #0078d4; } .img { color: #8a2be2; } .code { color: #107c10; } .priv { background: #fee; }
.txt { text-align: center; width: 100%; padding: 0 5px; box-sizing: border-box; }
.n { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 2px; }
.m { font-size: 11px; color: #999; }
.over { position: absolute; top: 5px; right: 5px; display: none; z-index: 2; gap: 4px; }
.item:hover .over { display: flex; }
.mini { width: 24px; height: 24px; background: #fff; border-radius: 4px; display: flex; align-items: center; justify-content: center; cursor: pointer; font-size: 12px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
.mini:hover { color: var(--p); }

/* List View (列表模式) */
.lst { display: flex; flex-direction: column; gap: 0; }
.lst .item { flex-direction: row; height: 44px; padding: 0 10px; border-radius: 0; border-bottom: 1px solid #eee; justify-content: flex-start; }
.lst .item:hover { transform: none; box-shadow: none; background: #f8f8f8; }
.lst .icon { font-size: 20px; width: 30px; height: 30px; margin-bottom: 0; margin-right: 10px; }
.lst .txt { text-align: left; flex: 1; }
.lst .over { position: static; display: flex; margin-left: auto; }
.lst .mini { background: transparent; box-shadow: none; width: auto; padding: 0 5px; }

/* 弹窗 & 表格 */
.modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); display: none; align-items: center; justify-content: center; z-index: 99; backdrop-filter: blur(2px); }
.modal.s { display: flex; }
.card { background: #fff; width: 320px; border-radius: 8px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.2); }
.mh { background: #f9f9f9; padding: 12px 15px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #eee; } .mh h3 { margin: 0; font-size: 15px; } .x { cursor: pointer; font-size: 20px; }
.mb { padding: 15px; }
.preview { background: #f0f0f0; padding: 8px; border-radius: 4px; font-size: 13px; color: #555; margin-bottom: 15px; word-break: break-all; }
.row { display: flex; gap: 8px; margin-bottom: 15px; }
input, select { padding: 8px; border: 1px solid #ddd; border-radius: 4px; flex: 1; outline: none; }
.ok { width: 100%; background: var(--p); color: #fff; border: none; padding: 10px; border-radius: 4px; cursor: pointer; }
.res { display: none; margin-top: 10px; gap: 5px; }
.tbl-box { background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.05); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { padding: 10px 15px; text-align: left; border-bottom: 1px solid #f0f0f0; } th { background: #fafafa; color: #666; }
.badge { padding: 3px 8px; border-radius: 10px; font-size: 12px; } .ok { background: #e6ffec; color: #0a0; } .no { background: #fff0f0; color: #d00; }
@media(max-width:600px){ .grid{grid-template-columns:repeat(auto-fill, minmax(100px, 1fr))} .over{display:flex;opacity:1;top:auto;bottom:5px;right:5px} .lst .over{margin-left:auto} }
</style></head><body>`;
}
