export const workflowMetadata = Object.freeze({
  workflowVersion: '2026.08.24.1',
  workflowApiVersion: 1,
  bridgeApiVersion: 1,
  parserVersion: 'webview-2026.08.24.1',
});

const SCORE_BATCH_SIZE = 400;
const LOGIN_TIMEOUT_MS = 5 * 60_000;
const LOGIN_POLL_INTERVAL_MS = 1_000;
const AUTH_FAILURE_MARKERS = [
  'open.weixin.qq.com',
  '连接时间已过期',
  '错误码：100001',
  '错误码：200002',
];

export async function run(context) {
  assertContext(context);
  if (context.mode === 'login') {
    return runLogin(context);
  }
  if (context.mode === 'recent' || context.mode === 'full') {
    return runScoreUpdate(context);
  }
  throw new Error('动态 Workflow 收到未知运行模式');
}

async function runScoreUpdate(context) {
  report(context, 'prepare', 5, '正在读取网站登录状态…');
  const profile = await context.scoreHubRequest({ method: 'GET', path: '/me' });
  const websiteFriendCode = String(profile?.friendCode ?? '').trim();
  requireFriendCode(websiteFriendCode, '网站账号好友码');

  report(context, 'oauth', 10, '正在启动微信授权…');
  await context.startOAuth();
  report(context, 'session', 28, '授权完成，正在校验 DXNET 会话…');

  const dxnetFriendCode = await fetchCurrentFriendCode(context);
  if (dxnetFriendCode !== websiteFriendCode) {
    throw new Error('网站账号好友码与当前微信 DXNET 账号不一致');
  }

  report(context, 'catalog', 42, '正在下载曲目目录…');
  const catalog = await context.scoreHubRequest({
    method: 'GET',
    path: '/catalog/music',
  });
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error('曲目目录为空');
  }

  let scores;
  if (context.mode === 'recent') {
    report(context, 'fetch_scores', 58, '正在读取最近游玩…');
    const html = await fetchDxnetPage(context, '/record/');
    report(context, 'parse_scores', 74, '正在解析最近游玩…');
    const parsed = parseRecent(html, catalog);
    assertUsefulParse(parsed, '最近游玩');
    scores = parsed.scores;
  } else {
    scores = [];
    for (let difficulty = 0; difficulty <= 4; difficulty += 1) {
      const current = difficulty + 1;
      report(
        context,
        'fetch_scores',
        45 + current * 8,
        `正在读取全部成绩 ${current}/5…`,
        { current, total: 5 },
      );
      const html = await fetchDxnetPage(
        context,
        `/record/musicGenre/search/?genre=99&diff=${difficulty}`,
      );
      const parsed = parseFull(difficulty, html, catalog);
      assertUsefulParse(parsed, `难度 ${difficulty}`);
      scores.push(...parsed.scores);
    }
  }

  if (scores.length === 0) {
    throw new Error('本次解析未产生可上传成绩');
  }

  report(context, 'upload', 88, `解析完成，共 ${scores.length} 条，正在写入…`, {
    current: 0,
    total: scores.length,
  });
  const upload = await uploadScores(context, scores);
  report(context, 'verify', 97, '成绩已写入，正在校验版本…');
  const latest = await context.scoreHubRequest({
    method: 'GET',
    path: '/me/sync/latest',
  });
  const persistedVersion = numberOr(latest?.scoreVersion, -1);
  if (upload.scoreVersion >= 0 && persistedVersion < upload.scoreVersion) {
    throw new Error('Backend 成绩版本校验失败');
  }

  return {
    workflowVersion: workflowMetadata.workflowVersion,
    parserVersion: workflowMetadata.parserVersion,
    submitted: upload.submitted,
    changed: upload.changed,
    scoreVersion: persistedVersion,
    message: `更新完成：提交 ${upload.submitted} 条，提升 ${upload.changed} 条，版本 ${persistedVersion}`,
  };
}

async function runLogin(context) {
  report(context, 'oauth', 8, '正在启动微信授权…');
  await context.startOAuth();
  report(context, 'identity', 30, '正在读取当前微信的 DXNET 身份…');
  const friendCode = await fetchCurrentFriendCode(context);

  report(context, 'assign_bot', 40, '已读取 DXNET 身份，正在分配 Bot…');
  const attempt = await context.scoreHubRequest({
    method: 'POST',
    path: '/auth/login-requests',
    body: { friendCode, method: 'user_sends_request' },
    authenticated: false,
  });
  if (attempt?.skipAuth === true && typeof attempt.token === 'string') {
    return {
      workflowVersion: workflowMetadata.workflowVersion,
      token: attempt.token,
      message: '微信登录成功',
    };
  }

  const jobId = String(attempt?.jobId ?? '');
  const botFriendCode = String(
    attempt?.botFriendCode ?? attempt?.job?.botUserFriendCode ?? '',
  );
  if (!/^[A-Za-z0-9-]{8,80}$/.test(jobId)) {
    throw new Error('Backend 登录响应缺少有效任务编号');
  }
  requireFriendCode(botFriendCode, 'Backend 登录响应 Bot 好友码');
  if (friendCode === botFriendCode) {
    throw new Error('当前微信账号与分配的 Bot 账号相同');
  }

  report(context, 'friend_request', 52, '正在向 Bot 发送好友申请…');
  await sendFreshFriendRequest(context, botFriendCode);
  report(context, 'wait_bot', 70, '好友申请已发送，正在等待 Bot 自动接受…');
  try {
    await context.scoreHubRequest({
      method: 'POST',
      path: `/auth/login-requests/${encodeURIComponent(jobId)}/verify`,
      body: {},
      authenticated: false,
    });
  } catch (error) {
    context.log?.('warn', `唤醒登录任务失败，继续轮询：${errorMessage(error)}`);
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastStage = '';
  while (Date.now() < deadline) {
    const result = await context.scoreHubRequest({
      method: 'GET',
      path: `/auth/login-requests/${encodeURIComponent(jobId)}`,
      authenticated: false,
    });
    const job =
      result?.job && typeof result.job === 'object' ? result.job : null;
    const status = String(result?.status ?? job?.status ?? '');
    const stage = String(job?.stage ?? '');
    const error = String(result?.error ?? job?.error ?? '');
    if (status === 'completed') {
      const token = String(result?.token ?? '');
      if (!token) {
        throw new Error('登录任务完成但未返回登录凭证');
      }
      return {
        workflowVersion: workflowMetadata.workflowVersion,
        token,
        message: '微信登录成功，正在进入 Score Hub…',
      };
    }
    if (status === 'failed' || status === 'canceled') {
      throw new Error(error || 'Bot 好友验证失败');
    }
    if (stage && stage !== lastStage) {
      lastStage = stage;
      report(
        context,
        'wait_bot',
        stage === 'accept_request' ? 88 : 76,
        stage === 'accept_request'
          ? 'Bot 已发现好友申请，正在确认好友关系…'
          : '正在等待 Bot 处理好友申请…',
      );
    }
    await context.sleep(LOGIN_POLL_INTERVAL_MS);
  }
  throw new Error('等待 Bot 接受好友申请超时');
}

async function fetchCurrentFriendCode(context) {
  const html = await fetchDxnetPage(context, '/friend/userFriendCode/');
  const document = parseDocument(html);
  const block = document.querySelector(
    '.see_through_block.m_t_5.m_b_5.p_5.t_c.f_15',
  );
  const friendCode = normalize(block?.textContent ?? '').replace(/\s+/g, '');
  requireFriendCode(friendCode, 'DXNET 好友码');
  return friendCode;
}

async function sendFreshFriendRequest(context, friendCode) {
  requireFriendCode(friendCode, 'Bot 好友码');
  await normalizeFriendRelation(context, friendCode);
  await postFriendAction(
    context,
    '/friend/search/invite/',
    friendCode,
    'invite',
  );
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const relation = await fetchFriendRelation(context, friendCode);
    if (relation === 'sent' || relation === 'friend') {
      return;
    }
    await context.sleep(500);
  }
  throw new Error('DXNET 未确认好友申请已发送');
}

async function normalizeFriendRelation(context, friendCode) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const relation = await fetchFriendRelation(context, friendCode);
    if (relation === 'none') {
      return;
    }
    if (relation === 'sent') {
      await postFriendAction(
        context,
        '/friend/invite/cancel/',
        friendCode,
        'invite',
      );
    } else if (relation === 'received') {
      await postFriendAction(
        context,
        '/friend/accept/block/',
        friendCode,
        'block',
      );
    } else {
      await postFriendAction(
        context,
        '/friend/friendDetail/drop/',
        friendCode,
        null,
      );
    }
    await context.sleep(500);
  }
  throw new Error('无法清理与 Bot 的旧好友状态');
}

async function fetchFriendRelation(context, friendCode) {
  const html = await fetchDxnetPage(
    context,
    `/friend/search/searchUser/?friendCode=${encodeURIComponent(friendCode)}`,
  );
  const document = parseDocument(html);
  for (const icon of document.querySelectorAll('img[src*="icon_each"]')) {
    const relation = normalize(icon.parentElement?.textContent ?? '').replace(
      /\s+/g,
      '',
    );
    if (relation.includes('申请中的好友')) return 'sent';
    if (relation.includes('收到的好友申请')) return 'received';
    if (relation.includes('好友') && !relation.includes('申请'))
      return 'friend';
  }
  return 'none';
}

async function postFriendAction(context, path, friendCode, submitField) {
  const form = { idx: friendCode };
  if (submitField) form[submitField] = '';
  const response = await context.dxnetRequest({
    method: 'POST',
    path,
    form,
    attachCsrfToken: true,
  });
  assertDxnetResponse(response, path);
  assertLoggedIn(response.body ?? '');
}

async function fetchDxnetPage(context, path) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await context.dxnetRequest({ method: 'GET', path });
      assertDxnetResponse(response, path);
      assertLoggedIn(response.body ?? '');
      return response.body ?? '';
    } catch (error) {
      lastError = error;
      const message = errorMessage(error);
      if (message.includes('维护中') || attempt === 3) {
        throw error;
      }
      await context.sleep(750 * attempt);
    }
  }
  throw lastError ?? new Error(`DXNET 请求失败 ${path}`);
}

function assertDxnetResponse(response, path) {
  const body = String(response?.body ?? '');
  throwIfMaintenance(body);
  const status = Number(response?.status ?? 0);
  if (status < 200 || status >= 400) {
    throw new Error(`DXNET 请求失败 ${path}，HTTP ${status}`);
  }
}

function throwIfMaintenance(body) {
  if (body.includes('系统正在维护中') || body.includes('正在维护中')) {
    throw new Error('DXNET 每日维护中（04:00–07:00）');
  }
}

function assertLoggedIn(html) {
  for (const marker of AUTH_FAILURE_MARKERS) {
    if (html.includes(marker)) {
      throw new Error('DXNET 登录状态已失效');
    }
  }
}

function parseRecent(html, catalog) {
  assertScorePage(html, 'recent');
  const document = parseDocument(html);
  const cards = [];
  for (const row of document.querySelectorAll('.p_10.t_l.f_0.v_b')) {
    const title = recentTitle(row);
    const chartIndex = recentDifficulty(row);
    if (!title || chartIndex === null) continue;
    const pair = parseScorePair(
      text(row.querySelector('.playlog_score_block > .f_15')),
    );
    const status = parseStatuses(
      Array.from(
        row.querySelectorAll('.playlog_result_innerblock > img'),
        (icon) => icon.getAttribute('src') ?? '',
      ),
    );
    cards.push({
      title,
      type: recentSongType(row, chartIndex),
      chartIndex,
      level: normalize(text(row.querySelector('.music_lv_back'))),
      achievement: parsePercentage(
        text(row.querySelector('.playlog_achievement_txt')),
      ),
      dxScore: pair?.score ?? null,
      dxScoreMax: pair?.max ?? null,
      fc: status.fc,
      fs: status.fs,
    });
  }
  return mapCards(cards, catalog, 'recent', null);
}

function parseFull(difficulty, html, catalog) {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 4) {
    throw new Error('成绩难度参数无效');
  }
  assertScorePage(html, 'full');
  const document = parseDocument(html);
  const cards = [];
  for (const form of document.querySelectorAll('form[action*="musicDetail"]')) {
    const name = form.querySelector('.music_name_block');
    const title = normalize(text(name));
    if (!title) continue;
    let achievement = null;
    let pair = null;
    let standaloneScore = null;
    for (const block of form.querySelectorAll('.music_score_block')) {
      const value = normalize(block.textContent ?? '');
      achievement ??= parsePercentage(value);
      pair ??= parseScorePair(value);
      standaloneScore ??= parseStandaloneScore(value);
    }
    const status = parseStatuses(
      Array.from(
        form.querySelectorAll('img'),
        (icon) => icon.getAttribute('src') ?? '',
      ),
    );
    cards.push({
      title,
      type: fullSongType(form, name, difficulty),
      chartIndex: difficulty,
      level: normalize(text(form.querySelector('.music_lv_block'))),
      achievement,
      dxScore: pair?.score ?? standaloneScore,
      dxScoreMax: pair?.max ?? null,
      fc: status.fc,
      fs: status.fs,
    });
  }
  return mapCards(cards, catalog, 'full', difficulty);
}

function assertScorePage(html, mode) {
  assertLoggedIn(html);
  const recognizable =
    html.includes('music_score_block') ||
    html.includes('playlog_achievement_txt') ||
    (mode === 'full' &&
      html.includes('music_name_block') &&
      html.includes('musicDetail'));
  if (!recognizable) {
    throw new Error('DXNET 页面结构无法识别，请更新动态解析器');
  }
}

function recentTitle(row) {
  const block = row.querySelector('.basic_block');
  if (block) {
    const nodes = Array.from(block.childNodes).reverse();
    for (const node of nodes) {
      if (node.nodeType === 3) {
        const value = normalize(node.textContent ?? '');
        if (value) return value;
      }
    }
  }
  return normalize(text(row.querySelector('.music_name_block')));
}

function recentDifficulty(row) {
  const source = (
    row.querySelector('img.playlog_diff')?.getAttribute('src') ?? ''
  ).toLowerCase();
  const fromSource = difficultyFromText(source);
  if (fromSource !== null) return fromSource;
  return difficultyFromText(
    String(row.children?.[1]?.className ?? '').toLowerCase(),
  );
}

function difficultyFromText(value) {
  if (value.includes('utage')) return 10;
  if (value.includes('remaster')) return 4;
  if (value.includes('master')) return 3;
  if (value.includes('expert')) return 2;
  if (value.includes('advanced')) return 1;
  if (value.includes('basic')) return 0;
  return null;
}

function recentSongType(row, chartIndex) {
  if (chartIndex === 10) return 'utage';
  const source = (
    row.querySelector('img.playlog_music_kind_icon')?.getAttribute('src') ?? ''
  ).toLowerCase();
  return source.includes('music_dx') ? 'dx' : 'standard';
}

function fullSongType(form, name, chartIndex) {
  if (chartIndex === 10) return 'utage';
  const formId = String(form.id ?? '').toLowerCase();
  if (formId) return formId.includes('dx') ? 'dx' : 'standard';

  let ancestor = name;
  for (let index = 0; index < 3 && ancestor; index += 1) {
    ancestor = ancestor.parentElement;
  }
  if (ancestor?.id) {
    return ancestor.id.toLowerCase().startsWith('sta') ? 'standard' : 'dx';
  }

  let sources = Array.from(
    form.querySelectorAll('img'),
    (image) => image.getAttribute('src') ?? '',
  ).join(' ');
  const siblingAnchor = name?.parentElement?.parentElement ?? null;
  let sibling = siblingAnchor?.nextElementSibling ?? null;
  while (sibling) {
    if (sibling.tagName?.toLowerCase() === 'img') {
      sources += ` ${sibling.getAttribute('src') ?? ''}`;
      break;
    }
    sibling = sibling.nextElementSibling;
  }
  return /(?:music_|_)dx(?:[_.]|$)/i.test(sources) ? 'dx' : 'standard';
}

function parseStatuses(sources) {
  const result = { fc: null, fs: null };
  for (const source of sources) {
    const name = iconName(source);
    if (hasIconName(name, 'app', 'applus')) result.fc = 'app';
    else if (hasIconName(name, 'ap')) result.fc = 'ap';
    else if (hasIconName(name, 'fcp', 'fcplus')) result.fc = 'fcp';
    else if (hasIconName(name, 'fc')) result.fc = 'fc';

    if (hasIconName(name, 'fdxp', 'fsdp', 'fsdplus')) result.fs = 'fdxp';
    else if (hasIconName(name, 'fdx', 'fsd')) result.fs = 'fdx';
    else if (hasIconName(name, 'fsp', 'fsplus')) result.fs = 'fsp';
    else if (hasIconName(name, 'fs')) result.fs = 'fs';
  }
  return result;
}

function iconName(source) {
  const normalized = String(source).toLowerCase().split('?', 1)[0];
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

function hasIconName(name, ...aliases) {
  return aliases.some((alias) => name === alias || name.endsWith(`_${alias}`));
}

function parsePercentage(value) {
  const match = String(value).match(/([0-9]{1,3}(?:\.[0-9]{1,4})?)\s*%/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 101
    ? parsed
    : null;
}

function parseScorePair(value) {
  const match = String(value).match(/([0-9][0-9,]*)\s*\/\s*([0-9][0-9,]*)/);
  if (!match) return null;
  const score = Number(match[1].replaceAll(',', ''));
  const max = Number(match[2].replaceAll(',', ''));
  return Number.isSafeInteger(score) &&
    Number.isSafeInteger(max) &&
    max >= score
    ? { score, max }
    : null;
}

function parseStandaloneScore(value) {
  const normalized = String(value).trim();
  if (
    normalized.includes('%') ||
    normalized.includes('/') ||
    !/^\d[\d,]*$/.test(normalized)
  ) {
    return null;
  }
  const parsed = Number(normalized.replaceAll(',', ''));
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function mapCards(cards, catalogInput, mode, difficulty) {
  const catalog = Array.isArray(catalogInput)
    ? catalogInput
        .filter((row) => row && row.id != null && row.title && row.type)
        .map((row) => ({
          id: String(row.id),
          title: String(row.title),
          type: String(row.type),
          charts: Array.isArray(row.charts) ? row.charts : [],
        }))
    : [];
  const scores = new Map();
  const issues = [];
  let skippedCount = 0;

  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index];
    if (!hasScore(card)) {
      skippedCount += 1;
      continue;
    }
    const candidates = catalog.filter(
      (music) =>
        normalize(music.title) === normalize(card.title) &&
        music.type === card.type,
    );
    const catalogChartIndex = card.chartIndex === 10 ? 0 : card.chartIndex;
    const withChart = candidates.filter(
      (music) => music.charts[catalogChartIndex] != null,
    );
    const levelMatches = card.level
      ? withChart.filter(
          (music) =>
            normalize(music.charts[catalogChartIndex]?.level ?? '') ===
            normalize(card.level),
        )
      : [];
    const maxMatches =
      card.dxScoreMax == null
        ? []
        : withChart.filter(
            (music) =>
              chartDxScoreMax(music, catalogChartIndex) === card.dxScoreMax,
          );
    const selected =
      unique(maxMatches) ?? unique(levelMatches) ?? unique(withChart);
    if (!selected) {
      issues.push({
        index,
        title: card.title,
        type: card.type,
        chartIndex: card.chartIndex,
        level: card.level,
        reason:
          candidates.length === 0
            ? 'music_not_found'
            : withChart.length === 0
              ? 'chart_not_found'
              : 'music_ambiguous',
      });
      continue;
    }
    const incoming = {
      musicId: selected.id,
      chartIndex: card.chartIndex,
      ...(card.achievement != null ? { achievement: card.achievement } : {}),
      ...(card.dxScore != null ? { dxScore: card.dxScore } : {}),
      ...(card.fc ? { fc: card.fc } : {}),
      ...(card.fs ? { fs: card.fs } : {}),
    };
    const key = `${incoming.musicId}:${incoming.chartIndex}`;
    scores.set(key, mergeScore(scores.get(key), incoming));
  }

  return {
    parserVersion: workflowMetadata.parserVersion,
    mode,
    difficulty,
    scores: [...scores.values()],
    diagnostics: {
      cardCount: cards.length,
      parsedCount: scores.size,
      skippedCount,
      unmatchedCount: issues.length,
      issues: issues.slice(0, 50),
    },
  };
}

function chartDxScoreMax(music, chartIndex) {
  const raw = music.charts[chartIndex]?.notes;
  const notes = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.notes)
      ? raw.notes
      : null;
  if (
    !notes ||
    notes.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    return null;
  }
  return notes.reduce((sum, value) => sum + value, 0) * 3;
}

function mergeScore(current, incoming) {
  if (!current) return { ...incoming };
  const merged = { ...current };
  if (
    incoming.achievement != null &&
    (merged.achievement == null || incoming.achievement > merged.achievement)
  ) {
    merged.achievement = incoming.achievement;
  }
  if (
    incoming.dxScore != null &&
    (merged.dxScore == null || incoming.dxScore > merged.dxScore)
  ) {
    merged.dxScore = incoming.dxScore;
  }
  if (fcRank(incoming.fc) > fcRank(merged.fc)) merged.fc = incoming.fc;
  if (fsRank(incoming.fs) > fsRank(merged.fs)) merged.fs = incoming.fs;
  return merged;
}

function fcRank(value) {
  return { fc: 1, fcp: 2, ap: 3, app: 4 }[value] ?? 0;
}

function fsRank(value) {
  return { fs: 1, fsp: 2, fdx: 3, fdxp: 4 }[value] ?? 0;
}

function hasScore(card) {
  return (
    card.achievement != null ||
    card.dxScore != null ||
    card.fc != null ||
    card.fs != null
  );
}

function unique(values) {
  return values.length === 1 ? values[0] : null;
}

function assertUsefulParse(result, label) {
  const cards = Number(result.diagnostics?.cardCount ?? 0);
  const unmatched = Number(result.diagnostics?.unmatchedCount ?? 0);
  if (unmatched > 0) {
    throw new Error(
      `${label}存在 ${unmatched} 个目录未匹配谱面，请更新动态解析器或曲目目录`,
    );
  }
  if (result.scores.length === 0 && cards === 0) {
    throw new Error(
      `${label}解析结果为空，页面卡片=${cards}，未匹配=${unmatched}`,
    );
  }
}

async function uploadScores(context, scores) {
  let submitted = 0;
  let changed = 0;
  let scoreVersion = -1;
  for (let offset = 0; offset < scores.length; offset += SCORE_BATCH_SIZE) {
    const batch = scores.slice(offset, offset + SCORE_BATCH_SIZE);
    const result = await context.scoreHubRequest({
      method: 'POST',
      path: '/me/sync/scores',
      body: { scores: batch },
    });
    submitted += numberOr(result?.submittedChartCount, batch.length);
    changed += numberOr(result?.changedChartCount, 0);
    scoreVersion = Math.max(scoreVersion, numberOr(result?.scoreVersion, -1));
    const completed = Math.min(offset + batch.length, scores.length);
    report(
      context,
      'upload',
      Math.min(96, 88 + (completed / scores.length) * 8),
      `正在写入成绩 ${completed}/${scores.length}…`,
      { current: completed, total: scores.length },
    );
  }
  return { submitted, changed, scoreVersion };
}

function report(context, stage, progress, message, details) {
  context.report({
    mode: context.mode,
    stage,
    progress,
    message,
    ...(details ? { details } : {}),
  });
}

function parseDocument(html) {
  return new DOMParser().parseFromString(String(html), 'text/html');
}

function text(element) {
  return element?.textContent ?? '';
}

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function requireFriendCode(value, label) {
  if (!/^\d{15}$/.test(String(value))) {
    throw new Error(`${label}格式无效`);
  }
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function assertContext(context) {
  if (
    !context ||
    typeof context.startOAuth !== 'function' ||
    typeof context.dxnetRequest !== 'function' ||
    typeof context.scoreHubRequest !== 'function' ||
    typeof context.report !== 'function' ||
    typeof context.sleep !== 'function'
  ) {
    throw new Error('WebView Workflow 宿主能力不完整');
  }
  if (typeof DOMParser !== 'function') {
    throw new Error('当前 WebView 缺少 DOMParser');
  }
}
