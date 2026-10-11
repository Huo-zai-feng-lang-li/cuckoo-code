/**
 * Cuckoo 插件市场目录同步脚本
 *
 * 用 `gh api` 而不是 Node fetch —— 本机走系统代理（MITM），
 * Node 自带 CA 不认代理证书，fetch 直接失败（实测）。
 * gh CLI 走系统证书库，且已登录（带 token 提升限流）。
 *
 * 用法：node scripts/sync-market.mjs --out <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TOPIC = 'cuckoo-plugin';
const GH = process.env.GH_PATH || 'C:\\Program Files\\GitHub CLI\\gh.exe';

function ghApi(args) {
  try {
    const out = execFileSync(GH, ['api', ...args], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });
    return out;
  } catch (e) {
    throw new Error('gh api 失败: ' + (e && e.message ? e.message : e));
  }
}

function ghApiJson(args) {
  return JSON.parse(ghApi(args));
}

/** 拉仓库根文件（raw），失败返回 null */
function ghRaw(repo, branch, file) {
  try {
    return ghApi(['repos/' + repo + '/contents/' + file + '?ref=' + branch, '-H', 'Accept: application/vnd.github.raw']);
  } catch {
    return null;
  }
}

// ===== 分类规则 =====
const CATEGORY_RULES = [
  { id: 'platform', zh: '平台接入', en: 'Platform', kw: ['platform', 'provider', 'doubao', 'zhipu', 'mimo', 'shanhai', 'chatgpt', 'claude', 'gemini', '豆包', '智谱', '平台', '大模型'] },
  { id: 'tools', zh: '工具与能力', en: 'Tools', kw: ['tool', 'mcp', 'tunnel', 'browser', '工具', '穿透', '浏览器'] },
  { id: 'ui', zh: '界面增强', en: 'UI', kw: ['ui', 'panel', 'theme', 'sidebar', '界面', '面板', '主题'] },
  { id: 'agents', zh: '子代理', en: 'Agents', kw: ['agent', 'subagent', '代理'] },
  { id: 'skills', zh: '技能包', en: 'Skills', kw: ['skill', '技能'] },
  { id: 'workflow', zh: '工作流', en: 'Workflow', kw: ['workflow', 'automation', '工作流', '自动化'] },
  { id: 'fun', zh: '娱乐', en: 'Fun', kw: ['fun', 'prank', '娱乐', '整活'] },
];

function guessCategory(name, desc) {
  const t = (String(name || '') + ' ' + String(desc || '')).toLowerCase();
  for (const r of CATEGORY_RULES) {
    for (const k of r.kw) {
      if (t.includes(k.toLowerCase())) return r.id;
    }
  }
  return 'other';
}

function searchAll() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const url = 'search/repositories?q=' + encodeURIComponent('topic:' + TOPIC) +
      '&per_page=100&page=' + page + '&sort=updated';
    const data = ghApiJson([url]);
    const items = (data && data.items) || [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

function extractFirstImage(repo, branch, readme) {
  if (!readme) return null;
  const m = readme.match(/!\[[^\]]*\]\(([^)]+)\)/);
  if (!m) return null;
  const src = m[1].trim();
  if (/^https?:\/\//i.test(src)) return src;
  if (/^data:/i.test(src)) return null;
  const rel = src.replace(/^\.\//, '').replace(/^\//, '');
  return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + rel;
}

function fetchScreenshots(repo, branch) {
  const txt = ghRaw(repo, branch, 'screenshots.json');
  if (!txt) return null;
  try {
    const j = JSON.parse(txt);
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.screenshots) ? j.screenshots : null);
    if (!arr) return null;
    return arr.slice(0, 6).map((s) => {
      const v = String(s || '').trim();
      if (/^https?:\/\//i.test(v)) return v;
      return 'https://raw.githubusercontent.com/' + repo + '/' + branch + '/' + v.replace(/^\//, '');
    });
  } catch { return null; }
}

function main() {
  const args = process.argv.slice(2);
  let outPath = 'plugins.json';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') outPath = args[++i];
  }

  console.log('[sync] 扫描 topic:' + TOPIC + ' …');
  const repos = searchAll();
  console.log('[sync] 找到 ' + repos.length + ' 个仓库');

  const plugins = [];
  for (const r of repos) {
    const full = r.full_name;
    const branch = r.default_branch || 'main';
    let manifest = null;
    const mTxt = ghRaw(full, branch, 'plugin.json');
    if (mTxt) { try { manifest = JSON.parse(mTxt); } catch { manifest = null; } }
    const desc = (r.description || (manifest && manifest.description) || '').trim();
    const name = (manifest && manifest.name) || r.name;
    const category = guessCategory(r.name, desc);

    let shots = fetchScreenshots(full, branch);
    if (!shots || !shots.length) {
      const readme = ghRaw(full, branch, 'README.md');
      const first = extractFirstImage(full, branch, readme);
      if (first) shots = [first];
    }
    const cover = (shots && shots[0]) || ('https://opengraph.githubassets.com/1/' + full);

    plugins.push({
      id: full,
      owner: r.owner ? r.owner.login : full.split('/')[0],
      repo: full.split('/')[1],
      name: name,
      url: r.html_url,
      description: desc,
      category: category,
      version: (manifest && manifest.version) || '',
      minAppVersion: (manifest && manifest.minAppVersion) || '',
      stars: r.stargazers_count || 0,
      forks: r.forks_count || 0,
      language: r.language || '',
      license: (r.license && r.license.spdx_id) || '',
      archived: !!r.archived,
      defaultBranch: branch,
      pushedAt: r.pushed_at || '',
      updatedAt: r.updated_at || '',
      cover: cover,
      screenshots: shots || [],
    });
    console.log('  ok ' + full + '  [' + category + ']');
  }

  plugins.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return (b.stars || 0) - (a.stars || 0);
  });

  const categories = {};
  for (const r of CATEGORY_RULES) categories[r.id] = { en: r.en, zh: r.zh };
  categories['other'] = { en: 'Other', zh: '其它' };

  const doc = {
    name: 'cuckoo-plugin-market',
    url: 'https://github.com/8555uuy/cuckoo-plugin-market',
    source: 'topic:' + TOPIC,
    updated: new Date().toISOString().slice(0, 10),
    count: plugins.length,
    categories: categories,
    plugins: plugins,
  };

  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf-8');
  console.log('[sync] 已写出 ' + outPath + '（' + plugins.length + ' 个插件）');
}

main();
