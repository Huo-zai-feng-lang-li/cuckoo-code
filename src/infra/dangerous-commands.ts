/**
 * 危险命令检测（唯一真相源）
 *
 * 由原 main.js 拆分而来；原先 bash / pwsh / 覆盖层各维护一份不一致的列表，
 * 且正则全部用 ^ 锚定行首、只对整条命令做单次匹配，导致
 *   `echo hi && rm -rf /`、`cd /tmp & format c:` 之类的复合命令可轻易绕过。
 *
 * 现统一为：先按 shell 控制符（&& || ; | & 换行）把命令拆成独立段，
 * 剥除前导修饰词与 shell 包装器（sudo/env、cmd /c、powershell -Command、iex 等）后，
 * 再对每一段分别匹配危险模式。bash / pwsh / 覆盖层均调用本模块。
 *
 * 两条检测线（互不相同，调用方按场景选用）：
 *  - isDangerous(cmd)：硬拒绝——破坏性命令（删根/格式化/关机/删分区等）。
 *  - findDeliverySignature(cmd)：投递/反弹/持久化特征族——不直接拒绝，
 *    供主进程策略层弹窗确认（X-001 第二层）。
 *
 * 局限（黑名单固有）：无法可靠拦截脚本文件、变量展开等间接方式。
 * 生产环境应叠加白名单或强制用户确认。
 */

// 危险命令列表 —— 匹配到的命令会被 bash/pwsh 工具直接拒绝
const DANGEROUS_CMDS = [
  // —— Unix 风格 ——
  // rm 删除根目录 / 家目录 / $HOME：
  // 选项循环兼容带值选项（--interactive=never）与长选项（--no-preserve-root），修 A-004
  /^rm\s+(?:--?[a-z][a-z-]*(?:=\S+)?\s+)*(?:\/(?:\s|$|\*)|~(?:$|\s|\/(?:\s|$|\*))|\$HOME(?:\/|\s|$))/i,
  /^mkfs(?:\.\w+)?\b/i,
  /^dd\s+[^|]*\bof=\/dev\//i,
  // —— Windows cmd ——
  /^format\s+/i,
  /^del\s+\/[a-z]*[fsq]/i,
  /^(?:rd|rmdir)\s+\/[a-z]*s/i, // rd /s、rmdir /s
  /^shutdown\s+/i,
  /^taskkill\s+/i,
  /^diskpart\b/i,
  /^reg\s+delete\b/i,
  /^cipher\s+\/w/i,
  /^vssadmin\s+delete\b/i,
  /^bcdedit\b/i,
  // —— PowerShell ——
  /^stop-computer\b/i,
  /^restart-computer\b/i,
  /^clear-disk\b/i,
  /^format-volume\b/i,
  // Remove-Item：单独 -Recurse/-r 即拦（删非只读文件时 -Force 非必需，修 A-004）
  /^remove-item\b[^\n]*?-(?:recurse|r)\b/i,
  // PS 别名 rm/ri/del：-Recurse(-r) 配合 -Force(-fo)，或目标是 Windows 路径（C:\ 等）
  /^(?:rm|ri|del)\b[^\n]*?-(?:recurse|r)\b[^\n]*?-(?:force|fo)\b/i,
  /^(?:rm|ri|del)\b[^\n]*?-(?:recurse|r)\b[^\n]*?(?:[A-Za-z]:\\|~\\|\\\\)/i,
];

// 前导修饰词：剥除后才对内部真实命令做危险判断（防 `sudo rm -rf /` 绕过）
// 覆盖常见提权/包装命令，允许其后跟短选项（如 `sudo -u user`）
const CMD_WRAPPERS = /^(?:sudo|doas|env|nohup|command|time|nice|setsid|stdbuf)(?:\s+-[ugpC]\s+\S+|\s+-\S+|\s+[A-Za-z_]\w*=\S+)*\s+/i;

// Shell 包装器（第二阶段剥除，修 A-004）：剥到内层真实命令后二次检测。
// 注意顺序：powershell 的 preflags 合并成一条，避免 `-NoProfile` 挡掉 `-Command` 锚点。
const SHELL_WRAPPER_PATTERNS: RegExp[] = [
  /^(?:cmd|cmd\.exe)\s+\/[ck]\s+/i,
  /^(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:noprofile|noninteractive|nologo|executionpolicy|windowstyle)(?:\s+\S+)?\s+)*-(?:command|c|encodedcommand|enc)\s+/i,
  /^(?:iex|invoke-expression)\s+/i,
  /^start(?:\s+"[^"]*")?(?:\s+\/[a-z]+)*\s*/i,
  /^call\s+/i,
];

/**
 * 把一条复合命令按 shell 控制符拆成独立段。
 * 覆盖 cmd / bash / PowerShell 常见连接符：&& || ; | & 及换行。
 * 注意 alternation 顺序：&& 与 || 必须先于单字符 & | 匹配。
 * @param cmd 原始命令
 * @returns 去空白后的非空片段
 */
function splitShellSegments(cmd: string): string[] {
  return cmd
    .split(/\r?\n|&&|\|\||[;|&]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 剥除前导修饰词（sudo/env/nohup...），返回内部真实命令。
 * 例：`sudo -u root rm -rf /` → `rm -rf /`
 * @param segment 单个命令片段
 * @returns 剥除修饰词后的命令
 */
function stripWrappers(segment: string): string {
  let s = segment;
  while (CMD_WRAPPERS.test(s)) {
    s = s.replace(CMD_WRAPPERS, '');
  }
  return s;
}

/**
 * 剥掉成对包围引号（cmd /c "rmdir /s ..." → rmdir /s ...）。
 */
function stripOuterQuotes(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/**
 * 深度解包一个命令段：反复剥 sudo/env、cmd /c、powershell -Command、iex、start、call
 * 及成对引号，直到稳定。用于拿到内层真实命令做二次危险检测。
 * @param segment 单个命令片段
 * @returns 解包后的内层命令
 */
function unwrapSegment(segment: string): string {
  let s = segment.trim();
  for (let i = 0; i < 8; i++) {
    const prev = s;
    s = stripWrappers(s);
    for (const re of SHELL_WRAPPER_PATTERNS) {
      s = s.replace(re, '');
    }
    s = stripOuterQuotes(s);
    if (s === prev) break;
  }
  return s;
}

/**
 * 判断命令（或其任一分段）是否为危险命令。
 * @param cmd 原始命令（可为复合命令）
 * @returns 命中危险模式返回 true
 */
function isDangerous(cmd: string): boolean {
  if (!cmd || typeof cmd !== 'string') return false;
  const segments = splitShellSegments(cmd);
  for (const seg of segments) {
    const inner = unwrapSegment(seg);
    if (DANGEROUS_CMDS.some((pattern) => pattern.test(inner))) return true;
  }
  return false;
}

// ===== 投递/反弹/持久化特征族（X-001 第二层：命中→主进程弹窗，不直接拒绝）=====
// 顺序即优先级：更具体的模式排前面，命中即返回（first-match）。
const DELIVERY_SIGNATURES: Array<{ desc: string; re: RegExp }> = [
  { desc: 'PowerShell 编码执行(-enc/-EncodedCommand)', re: /(?:powershell|pwsh)(?:\.exe)?\s+-enc(?:odedcommand)?\b/i },
  { desc: 'PowerShell 编码执行(-e)', re: /(?:powershell|pwsh)(?:\.exe)?\s+-e\s+[A-Za-z0-9+/=]{8,}/ },
  { desc: 'PowerShell 隐藏窗口执行(-WindowStyle Hidden)', re: /(?:powershell|pwsh)(?:\.exe)?\s+[^\n]*-(?:windowstyle|w)\s+hidden/i },
  { desc: '下载后管道执行(iwr/irm/curl/wget → iex)', re: /(?:iwr|irm|invoke-webrequest|invoke-restmethod|curl|wget)[^\n|]*\|[^\n]*(?:iex|invoke-expression)/i },
  { desc: 'Invoke-Expression 执行(iex)', re: /\b(?:iex|invoke-expression)\b/i },
  { desc: 'certutil 下载/解码(-urlcache/-decode)', re: /certutil\b[^\n]*-(?:urlcache|decode|decodehex)/i },
  { desc: 'bitsadmin 传输(/transfer)', re: /bitsadmin\b[^\n]*\/transfer/i },
  { desc: 'mshta 远程执行', re: /\bmshta\b[^\n]*https?:\/\//i },
  { desc: 'wscript/cscript 跑远程脚本', re: /(?:wscript|cscript)\b[^\n]*https?:\/\//i },
  { desc: '写注册表 Run/RunOnce 持久化', re: /reg\s+add\b[^\n]*\\(?:run|runonce)(?:\\|\s|$)/i },
  { desc: '写启动文件夹持久化(Startup)', re: /Start Menu[\\/]+Programs[\\/]+Startup/i },
  { desc: '关闭 Defender 实时防护', re: /Add-MpPreference\b[^\n]*(?:DisableRealtimeMonitoring|ExclusionPath)/i },
  { desc: 'PowerShell 执行策略绕过(Bypass)', re: /(?:Set-ExecutionPolicy|-ExecutionPolicy)\b[^\n]*Bypass/i },
  { desc: '反弹 shell(nc/ncat -e)', re: /(?:^|\s)(?:nc|ncat)\b[^\n]*-e\s+\S+/ },
  { desc: '反弹 shell(bash /dev/tcp)', re: /bash[^\n]*\/dev\/tcp\// },
  { desc: 'Python 反弹/外联(socket connect)', re: /python[^\n]*socket[^\n]*\.connect\s*\(/ },
];

/**
 * 检测命令是否命中"投递/反弹/持久化"特征族。
 * 与 isDangerous 不同：这类动作不一定是破坏，但属于高危副作用，
 * 主进程策略层应弹窗让用户知情确认（见计划 X-001 第二层）。
 *
 * 检测同时看整条命令（抓"下载→执行"跨段管道）与逐段解包后的内容。
 *
 * @param cmd 原始命令
 * @returns 命中返回中文描述；未命中返回 null
 */
function findDeliverySignature(cmd: string): string | null {
  if (!cmd || typeof cmd !== 'string') return null;
  // 整条命令先过一遍（管道跨段场景：`iwr url | iex` 被 split 拆开就看不出来）
  for (const sig of DELIVERY_SIGNATURES) {
    if (sig.re.test(cmd)) return sig.desc;
  }
  // 逐段解包再过一遍（`powershell -c "iex ..."` 内层）
  for (const seg of splitShellSegments(cmd)) {
    const inner = unwrapSegment(seg);
    for (const sig of DELIVERY_SIGNATURES) {
      if (sig.re.test(inner)) return sig.desc;
    }
  }
  return null;
}

export { DANGEROUS_CMDS, isDangerous, splitShellSegments, stripWrappers, unwrapSegment, findDeliverySignature, DELIVERY_SIGNATURES };
